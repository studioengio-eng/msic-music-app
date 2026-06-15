use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};

use crate::audio::resolver::resolve_optimized_newpipe;
use crate::intelligence::musicbrainz::MusicBrainzMetadata;

const STREAM_TTL: Duration = Duration::from_secs(45 * 60);
const HOT_QUEUE_LOOK_AHEAD: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueTrack {
    pub title: String,
    pub artist: String,
    pub video_id: String,
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaybackPayload {
    pub title: String,
    pub artist: String,
    pub stream_url: String,
    pub image_url: String,
}

#[derive(Debug, Clone)]
struct StreamEntry {
    url: String,
    created_at: Instant,
}

#[derive(Debug, Default)]
pub struct SmartCache {
    stream_urls: DashMap<String, StreamEntry>,
    youtube_to_mbid: DashMap<String, String>,
    mbid_metadata: DashMap<String, MusicBrainzMetadata>,
    active_queue: DashMap<String, QueueTrack>,
}

impl SmartCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put_stream(&self, track_id: impl Into<String>, url: impl Into<String>) {
        self.stream_urls.insert(
            track_id.into(),
            StreamEntry {
                url: url.into(),
                created_at: Instant::now(),
            },
        );
    }

    pub fn get_valid_stream(&self, id: &str) -> Option<String> {
        let entry = self.stream_urls.get(id)?;
        if entry.value().created_at.elapsed() <= STREAM_TTL {
            Some(entry.value().url.clone())
        } else {
            drop(entry);
            self.stream_urls.remove(id);
            None
        }
    }

    pub fn stream_is_expired(&self, id: &str) -> bool {
        self.stream_urls
            .get(id)
            .map(|entry| entry.value().created_at.elapsed() > STREAM_TTL)
            .unwrap_or(true)
    }

    pub fn put_youtube_mbid(&self, youtube_id: impl Into<String>, mbid: impl Into<String>) {
        self.youtube_to_mbid.insert(youtube_id.into(), mbid.into());
    }

    pub fn get_youtube_mbid(&self, youtube_id: &str) -> Option<String> {
        self.youtube_to_mbid
            .get(youtube_id)
            .map(|entry| entry.value().clone())
    }

    pub fn put_mbid_metadata(&self, metadata: MusicBrainzMetadata) {
        self.mbid_metadata.insert(metadata.mbid.clone(), metadata);
    }

    pub fn get_mbid_metadata(&self, mbid: &str) -> Option<MusicBrainzMetadata> {
        self.mbid_metadata
            .get(mbid)
            .map(|entry| entry.value().clone())
    }

    pub fn purge_expired_streams(&self) {
        let expired: Vec<String> = self
            .stream_urls
            .iter()
            .filter_map(|entry| {
                if entry.value().created_at.elapsed() > STREAM_TTL {
                    Some(entry.key().clone())
                } else {
                    None
                }
            })
            .collect();

        for key in expired {
            self.stream_urls.remove(&key);
        }
    }

    pub fn clear_transient_streams(&self) {
        self.stream_urls.clear();
    }

    pub fn track_key(title: &str, artist: &str) -> String {
        format!("{}__{}", normalize_key(title), normalize_key(artist))
    }

    pub fn queue_key(track: &QueueTrack) -> String {
        Self::track_key(&track.title, &track.artist)
    }

    pub fn set_active_queue(&self, tracks: Vec<QueueTrack>) {
        self.active_queue.clear();
        for track in tracks {
            self.active_queue.insert(Self::queue_key(&track), track);
        }
    }

    pub async fn payload_for_track(self: &Arc<Self>, track: QueueTrack) -> Result<PlaybackPayload, String> {
        let key = Self::queue_key(&track);
        let stream_url = match self.get_valid_stream(&key) {
            Some(url) => url,
            None => {
                let fresh = resolve_optimized_newpipe(&track.video_id).await?;
                self.put_stream(key.clone(), fresh.clone());
                fresh
            }
        };

        Ok(PlaybackPayload {
            title: track.title,
            artist: track.artist,
            stream_url,
            image_url: track
                .image_url
                .unwrap_or_else(|| "asset://localhost/assets/default_cover.png".to_string()),
        })
    }

    pub async fn ensure_hot_queue(self: Arc<Self>, queue: Vec<QueueTrack>, current_index: usize) {
        self.set_active_queue(queue.clone());
        let look_ahead = queue
            .into_iter()
            .skip(current_index.saturating_add(1))
            .take(HOT_QUEUE_LOOK_AHEAD)
            .collect::<VecDeque<_>>();

        for track in look_ahead {
            let key = Self::queue_key(&track);
            if !self.stream_is_expired(&key) {
                continue;
            }
            match resolve_optimized_newpipe(&track.video_id).await {
                Ok(url) => self.put_stream(key, url),
                Err(error) => log::warn!("No se pudo rellenar cola caliente: {error}"),
            }
        }
    }

    pub fn spawn_refill(self: Arc<Self>, queue: Vec<QueueTrack>, consumed_index: usize) {
        tokio::spawn(async move {
            self.ensure_hot_queue(queue, consumed_index).await;
        });
    }
}

fn normalize_key(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}
