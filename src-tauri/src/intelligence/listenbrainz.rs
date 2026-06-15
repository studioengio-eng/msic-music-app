use std::{collections::VecDeque, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};

use crate::{
    cache::smart_cache::SmartCache,
    intelligence::autoplay::CandidateTrack,
};

const LISTENBRAINZ_BASE: &str = "https://api.listenbrainz.org";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecommendedRecording {
    pub recording_mbid: String,
    pub title: String,
    pub artist_name: String,
    pub artist_mbid: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct LocalFallbackSeed {
    pub recent_tracks: VecDeque<CandidateTrack>,
    pub genres: Vec<String>,
}

#[derive(Clone)]
pub struct ListenBrainzClient {
    http: reqwest::Client,
    cache: Arc<SmartCache>,
}

impl ListenBrainzClient {
    pub fn new(cache: Arc<SmartCache>) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .user_agent("Msic/0.1 ListenBrainz async recommender")
            .timeout(Duration::from_secs(4))
            .pool_idle_timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("No se pudo crear ListenBrainzClient: {error}"))?;

        Ok(Self { http, cache })
    }

    pub async fn recommend_recordings(
        &self,
        recording_mbid: &str,
        fallback: LocalFallbackSeed,
    ) -> Vec<RecommendedRecording> {
        let url = format!("{LISTENBRAINZ_BASE}/1/recommend_recordings");
        let response = self
            .http
            .get(url)
            .query(&[("recording_mbid", recording_mbid), ("count", "25")])
            .send()
            .await;

        match response {
            Ok(response) if response.status().is_success() => {
                match response.json::<RecommendResponse>().await {
                    Ok(parsed) => parsed
                        .payload
                        .recordings
                        .into_iter()
                        .map(|item| RecommendedRecording {
                            recording_mbid: item.recording_mbid,
                            title: item.recording_name,
                            artist_name: item.artist_name,
                            artist_mbid: item.artist_mbid,
                        })
                        .collect(),
                    Err(error) => {
                        log::warn!("ListenBrainz devolvió JSON inválido: {error}");
                        self.local_fallback(fallback)
                    }
                }
            }
            Ok(response) => {
                log::warn!("ListenBrainz respondió {}, usando fallback local", response.status());
                self.local_fallback(fallback)
            }
            Err(error) => {
                log::warn!("ListenBrainz offline, usando fallback local: {error}");
                self.local_fallback(fallback)
            }
        }
    }

    pub async fn similar_artists(
        &self,
        artist_mbid: &str,
        fallback_artists: Vec<String>,
    ) -> Vec<String> {
        let url = format!("{LISTENBRAINZ_BASE}/1/artist/{artist_mbid}/similar-artists");
        let response = self.http.get(url).send().await;

        match response {
            Ok(response) if response.status().is_success() => response
                .json::<SimilarArtistsResponse>()
                .await
                .map(|parsed| {
                    parsed
                        .payload
                        .artists
                        .into_iter()
                        .map(|artist| artist.artist_mbid)
                        .collect()
                })
                .unwrap_or(fallback_artists),
            _ => fallback_artists,
        }
    }

    fn local_fallback(&self, fallback: LocalFallbackSeed) -> Vec<RecommendedRecording> {
        fallback
            .recent_tracks
            .into_iter()
            .filter(|track| {
                track
                    .genres
                    .iter()
                    .any(|genre| fallback.genres.iter().any(|wanted| wanted == genre))
                    || fallback.genres.is_empty()
            })
            .take(20)
            .map(|track| {
                if let Some(mbid) = &track.mbid {
                    if let Some(metadata) = self.cache.get_mbid_metadata(mbid) {
                        return RecommendedRecording {
                            recording_mbid: metadata.mbid,
                            title: metadata.title,
                            artist_name: track.artist_name,
                            artist_mbid: metadata.artist_mbids.first().cloned(),
                        };
                    }
                }

                RecommendedRecording {
                    recording_mbid: track
                        .mbid
                        .clone()
                        .unwrap_or_else(|| format!("youtube:{}", track.youtube_id)),
                    title: track.title,
                    artist_name: track.artist_name,
                    artist_mbid: Some(track.artist_id),
                }
            })
            .collect()
    }
}

#[derive(Debug, Deserialize)]
struct RecommendResponse {
    payload: RecommendPayload,
}

#[derive(Debug, Deserialize)]
struct RecommendPayload {
    recordings: Vec<ListenBrainzRecording>,
}

#[derive(Debug, Deserialize)]
struct ListenBrainzRecording {
    recording_mbid: String,
    recording_name: String,
    artist_name: String,
    artist_mbid: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SimilarArtistsResponse {
    payload: SimilarArtistsPayload,
}

#[derive(Debug, Deserialize)]
struct SimilarArtistsPayload {
    artists: Vec<SimilarArtist>,
}

#[derive(Debug, Deserialize)]
struct SimilarArtist {
    artist_mbid: String,
}
