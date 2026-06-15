use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex;
use tokio::task::{AbortHandle, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::{audio::resolver::resolve_optimized_newpipe, cache::smart_cache::SmartCache};

#[derive(Debug, Clone, Serialize)]
pub struct PreloadResult {
    pub track_id: String,
    pub url: String,
}

#[derive(Debug)]
struct ActivePreload {
    generation: u64,
    token: CancellationToken,
    abort_handle: AbortHandle,
    scratch_buffers: Vec<Vec<u8>>,
}

#[derive(Debug)]
pub struct PreloadManager {
    active: Mutex<Option<ActivePreload>>,
    cache: Arc<SmartCache>,
    generation: Mutex<u64>,
}

impl PreloadManager {
    pub fn new(cache: Arc<SmartCache>) -> Self {
        Self {
            active: Mutex::new(None),
            cache,
            generation: Mutex::new(0),
        }
    }

    pub async fn trigger_preload(&self, track_id: String) -> Option<PreloadResult> {
        self.cancel_active().await;

        if let Some(url) = self.cache.get_valid_stream(&track_id) {
            return Some(PreloadResult { track_id, url });
        }

        let generation = {
            let mut generation = self.generation.lock().await;
            *generation += 1;
            *generation
        };
        let token = CancellationToken::new();
        let task_token = token.clone();
        let task_track_id = track_id.clone();
        let cache = Arc::clone(&self.cache);

        let handle = tokio::spawn(async move {
            let work = async {
                tokio::select! {
                    _ = task_token.cancelled() => None,
                    result = resolve_youtube_stream(task_track_id.clone()) => {
                        match result {
                            Ok(url) => {
                                cache.put_stream(task_track_id.clone(), url.clone());
                                Some(PreloadResult { track_id: task_track_id, url })
                            }
                            Err(error) => {
                                log::warn!("Preload falló sin afectar playback: {error}");
                                None
                            }
                        }
                    }
                }
            };

            match tokio::time::timeout(Duration::from_secs(5), work).await {
                Ok(result) => result,
                Err(_) => {
                    log::warn!("Preload agotó el límite de 5 segundos");
                    None
                }
            }
        });
        let abort_handle = handle.abort_handle();

        {
            let mut active = self.active.lock().await;
            *active = Some(ActivePreload {
                generation,
                token,
                abort_handle,
                scratch_buffers: Vec::new(),
            });
        }

        let result = await_preload(handle).await;

        {
            let mut active = self.active.lock().await;
            if active
                .as_ref()
                .map(|active| active.generation == generation)
                .unwrap_or(false)
            {
                active.take();
            }
        }

        result
    }

    pub async fn cancel_active(&self) {
        let active = {
            let mut guard = self.active.lock().await;
            guard.take()
        };

        if let Some(mut active) = active {
            active.token.cancel();
            active.abort_handle.abort();
            active.scratch_buffers.clear();
        }
    }
}

async fn await_preload(handle: JoinHandle<Option<PreloadResult>>) -> Option<PreloadResult> {
    match handle.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => None,
        Err(error) => {
            log::warn!("Tarea de preload terminó con error: {error}");
            None
        }
    }
}

async fn resolve_youtube_stream(track_id: String) -> Result<String, String> {
    resolve_optimized_newpipe(&track_id).await
}

