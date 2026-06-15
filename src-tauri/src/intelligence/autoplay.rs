use std::collections::{HashSet, VecDeque};

use serde::{Deserialize, Serialize};

const DEFAULT_COVER: &str = "asset://localhost/assets/default_cover.png";

#[derive(Deserialize, Debug, Clone, Serialize)]
pub struct LastFmImage {
    #[serde(rename = "#text")]
    pub url: String,
    pub size: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TrackCandidate {
    pub title: String,
    pub artist: String,
    pub video_id: Option<String>,
    #[serde(default)]
    pub image: Vec<LastFmImage>,
}

pub fn official_cover_url(images: &[LastFmImage]) -> String {
    images
        .iter()
        .find(|image| image.size.eq_ignore_ascii_case("extralarge") && !image.url.trim().is_empty())
        .or_else(|| {
            images
                .iter()
                .find(|image| image.size.eq_ignore_ascii_case("large") && !image.url.trim().is_empty())
        })
        .map(|image| image.url.clone())
        .unwrap_or_else(|| DEFAULT_COVER.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CandidateTrack {
    pub youtube_id: String,
    pub mbid: Option<String>,
    pub title: String,
    pub artist_id: String,
    pub artist_name: String,
    pub genres: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScoredCandidate {
    pub track: CandidateTrack,
    pub score: i32,
}

#[derive(Debug, Default)]
pub struct AutoplayEngine {
    recent_track_ids: VecDeque<String>,
    recent_artist_ids: VecDeque<String>,
    recent_titles: VecDeque<String>,
    recent_artists: VecDeque<String>,
}

impl AutoplayEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn remember_played(&mut self, track_id: String, artist_id: String) {
        push_bounded(&mut self.recent_track_ids, track_id, 20);
        push_bounded(&mut self.recent_artist_ids, artist_id, 10);
    }

    pub fn remember_track(&mut self, title: String, artist: String) {
        push_bounded(&mut self.recent_titles, normalize(&title), 15);
        push_bounded(&mut self.recent_artists, normalize(&artist), 5);
    }

    pub fn select_next_track(
        &mut self,
        lastfm_candidates: Vec<TrackCandidate>,
    ) -> Option<TrackCandidate> {
        let current_artist = self.recent_artists.front().cloned();
        let winner = lastfm_candidates
            .into_iter()
            .filter(|c| !c.title.trim().is_empty() && !c.artist.trim().is_empty())
            .map(|candidate| {
                let score = self.score_lastfm_candidate(&candidate, current_artist.as_deref());
                (candidate, score)
            })
            .max_by_key(|(_, score)| *score)
            .map(|(candidate, _)| candidate);

        if let Some(track) = &winner {
            self.remember_track(track.title.clone(), track.artist.clone());
        }

        winner
    }

    fn score_lastfm_candidate(&self, candidate: &TrackCandidate, current_artist: Option<&str>) -> i32 {
        let title = normalize(&candidate.title);
        let artist = normalize(&candidate.artist);
        let mut score = 1000;

        if current_artist.map(|current| current == artist).unwrap_or(false) {
            score -= 800;
        }

        if self
            .recent_artists
            .iter()
            .filter(|recent| *recent == &artist)
            .count()
            >= 2
        {
            score -= 2000;
        }

        if self.recent_titles.iter().any(|recent| recent == &title) {
            score -= 5000;
        }

        for marker in [
            "slowed",
            "nightcore",
            "8d",
            "bass boosted",
            "podcast",
            "live",
            "cover",
            "remix",
            "karaoke",
        ] {
            if title.contains(marker) {
                score -= 1500;
            }
        }

        score
    }

    pub fn select_next(
        &self,
        candidates: Vec<CandidateTrack>,
        preferred_genres: &[String],
    ) -> Option<ScoredCandidate> {
        let recent_tracks = self
            .recent_track_ids
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        let recent_artists = self
            .recent_artist_ids
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        let last_artist = self.recent_artist_ids.front().cloned();

        candidates
            .into_iter()
            .filter(|candidate| !recent_tracks.contains(&candidate.youtube_id))
            .filter(|candidate| {
                candidate
                    .mbid
                    .as_ref()
                    .map(|mbid| !recent_tracks.contains(mbid))
                    .unwrap_or(true)
            })
            .filter(|candidate| !candidate.youtube_id.trim().is_empty() && !candidate.title.trim().is_empty())
            .map(|candidate| {
                let mut score = score_candidate(&candidate, preferred_genres, &recent_artists);
                if let Some(ref last) = last_artist {
                    if last == &candidate.artist_id {
                        score -= 150; // Heavy penalty for the immediately preceding artist
                    }
                }
                ScoredCandidate {
                    track: candidate,
                    score,
                }
            })
            .max_by_key(|candidate| candidate.score)
    }

    pub fn recent_track_ids(&self) -> Vec<String> {
        self.recent_track_ids.iter().cloned().collect()
    }

    pub fn recent_artist_ids(&self) -> Vec<String> {
        self.recent_artist_ids.iter().cloned().collect()
    }
}

fn normalize(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn push_bounded(queue: &mut VecDeque<String>, value: String, max_len: usize) {
    if let Some(pos) = queue.iter().position(|item| item == &value) {
        queue.remove(pos);
    }
    queue.push_front(value);
    while queue.len() > max_len {
        queue.pop_back();
    }
}

fn score_candidate(
    candidate: &CandidateTrack,
    preferred_genres: &[String],
    recent_artists: &HashSet<String>,
) -> i32 {
    let mut score = 100;
    let title = candidate.title.to_ascii_lowercase();

    for noisy_marker in [
        "remix",
        "sped up",
        "slowed",
        "nightcore",
        "karaoke",
        "cover",
        "bass boosted",
        "8d audio",
        "tiktok",
        "shorts",
        "reaction",
        "live",
    ] {
        if title.contains(noisy_marker) {
            score -= 35;
        }
    }

    if recent_artists.contains(&candidate.artist_id) {
        score -= 90;
    }

    let genre_hits = candidate
        .genres
        .iter()
        .filter(|genre| {
            preferred_genres
                .iter()
                .any(|preferred| preferred.eq_ignore_ascii_case(genre))
        })
        .count() as i32;
    score += genre_hits * 18;

    if candidate.mbid.is_some() {
        score += 12;
    }
    if candidate.youtube_id.trim().is_empty() || candidate.title.trim().is_empty() {
        score -= 100;
    }

    score
}
