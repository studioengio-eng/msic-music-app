use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};

use crate::cache::smart_cache::SmartCache;

const MUSICBRAINZ_BASE: &str = "https://musicbrainz.org/ws/2/recording/";
const USER_AGENT: &str = "Msic/0.1 (https://github.com/local/msic; contact: msic-app@example.local)";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MusicBrainzMetadata {
    pub mbid: String,
    pub title: String,
    pub artist_mbids: Vec<String>,
    pub album: Option<String>,
    pub genres: Vec<String>,
}

#[derive(Clone)]
pub struct MusicBrainzClient {
    http: reqwest::Client,
    cache: Arc<SmartCache>,
}

impl MusicBrainzClient {
    pub fn new(cache: Arc<SmartCache>) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(4))
            .pool_idle_timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("No se pudo crear MusicBrainzClient: {error}"))?;

        Ok(Self { http, cache })
    }

    pub async fn fetch_metadata(
        &self,
        title: &str,
        artist: &str,
    ) -> Result<MusicBrainzMetadata, String> {
        let fallback = fallback_metadata(title, artist);
        let query = format!("recording:\"{}\" AND artist:\"{}\"", title, artist);

        let response = match self
            .http
            .get(MUSICBRAINZ_BASE)
            .query(&[
                ("query", query.as_str()),
                ("fmt", "json"),
                ("limit", "8"),
                ("inc", "artist-credits+releases+genres+tags"),
            ])
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                log::warn!("MusicBrainz no disponible, usando metadata básica: {error}");
                return Ok(fallback);
            }
        };

        if !response.status().is_success() {
            log::warn!(
                "MusicBrainz respondió {}, usando metadata básica",
                response.status()
            );
            return Ok(fallback);
        }

        let parsed = match response.json::<MusicBrainzSearchResponse>().await {
            Ok(parsed) => parsed,
            Err(error) => {
                log::warn!("Respuesta MusicBrainz inválida, usando fallback: {error}");
                return Ok(fallback);
            }
        };

        let Some(best) = select_best_recording(parsed.recordings, title, artist) else {
            return Ok(fallback);
        };

        let metadata = to_metadata(best, &fallback);
        self.cache.put_mbid_metadata(metadata.clone());
        Ok(metadata)
    }
}

fn fallback_metadata(title: &str, artist: &str) -> MusicBrainzMetadata {
    MusicBrainzMetadata {
        mbid: format!("youtube-fallback:{}", normalize_id(&format!("{artist}-{title}"))),
        title: title.trim().to_string(),
        artist_mbids: vec![format!("artist-fallback:{}", normalize_id(artist))],
        album: None,
        genres: Vec::new(),
    }
}

fn normalize_id(value: &str) -> String {
    value
        .chars()
        .filter_map(|ch| {
            if ch.is_ascii_alphanumeric() {
                Some(ch.to_ascii_lowercase())
            } else if ch.is_whitespace() || matches!(ch, '-' | '_' | ':' | '/') {
                Some('-')
            } else {
                None
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn select_best_recording(
    recordings: Vec<Recording>,
    title: &str,
    artist: &str,
) -> Option<Recording> {
    let wanted_title = normalized_text(title);
    let wanted_artist = normalized_text(artist);

    recordings.into_iter().max_by_key(|recording| {
        let mut score = recording.score.unwrap_or(0) as i32;
        if normalized_text(&recording.title) == wanted_title {
            score += 40;
        }
        if recording
            .artist_credit
            .iter()
            .any(|credit| normalized_text(&credit.name).contains(&wanted_artist))
        {
            score += 30;
        }
        if recording
            .title
            .to_ascii_lowercase()
            .contains("remix")
        {
            score -= 15;
        }
        score
    })
}

fn normalized_text(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .replace("(official video)", "")
        .replace("official audio", "")
        .replace("lyrics", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn to_metadata(recording: Recording, fallback: &MusicBrainzMetadata) -> MusicBrainzMetadata {
    let artist_mbids = recording
        .artist_credit
        .iter()
        .filter_map(|credit| credit.artist.as_ref().map(|artist| artist.id.clone()))
        .collect::<Vec<_>>();

    let album = recording
        .releases
        .as_ref()
        .and_then(|releases| releases.first())
        .map(|release| release.title.clone());

    let mut genres = recording
        .genres
        .unwrap_or_default()
        .into_iter()
        .map(|genre| genre.name)
        .collect::<Vec<_>>();

    if genres.is_empty() {
        genres = recording
            .tags
            .unwrap_or_default()
            .into_iter()
            .filter(|tag| tag.count.unwrap_or(0) > 0)
            .take(5)
            .map(|tag| tag.name)
            .collect();
    }

    MusicBrainzMetadata {
        mbid: recording.id,
        title: if recording.title.trim().is_empty() {
            fallback.title.clone()
        } else {
            recording.title
        },
        artist_mbids: if artist_mbids.is_empty() {
            fallback.artist_mbids.clone()
        } else {
            artist_mbids
        },
        album,
        genres,
    }
}

#[derive(Debug, Deserialize)]
struct MusicBrainzSearchResponse {
    recordings: Vec<Recording>,
}

#[derive(Debug, Deserialize)]
struct Recording {
    id: String,
    title: String,
    score: Option<u16>,
    #[serde(default, rename = "artist-credit")]
    artist_credit: Vec<ArtistCredit>,
    releases: Option<Vec<Release>>,
    genres: Option<Vec<Genre>>,
    tags: Option<Vec<Tag>>,
}

#[derive(Debug, Deserialize)]
struct ArtistCredit {
    name: String,
    artist: Option<Artist>,
}

#[derive(Debug, Deserialize)]
struct Artist {
    id: String,
}

#[derive(Debug, Deserialize)]
struct Release {
    title: String,
}

#[derive(Debug, Deserialize)]
struct Genre {
    name: String,
}

#[derive(Debug, Deserialize)]
struct Tag {
    name: String,
    count: Option<i32>,
}
