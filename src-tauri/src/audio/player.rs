use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use tauri::{Emitter, WebviewWindow};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::audio::resolver::global_http_client;

#[derive(Debug, Clone, Serialize)]
pub struct PlaybackSnapshot {
    pub generation: u64,
    pub track_id: Option<String>,
    pub stream_url: Option<String>,
    pub proxy_url: String,
    pub position_ms: u64,
    pub playing: bool,
}

#[derive(Debug)]
struct PlaybackInner {
    track_id: Option<String>,
    stream_url: Option<String>,
    started_at: Option<Instant>,
    paused_at_ms: u64,
}

#[derive(Debug)]
pub struct PersistentAudioPlayer {
    inner: RwLock<PlaybackInner>,
    http: reqwest::Client,
    proxy_url: String,
    generation: AtomicU64,
    playing: AtomicBool,
    proxy_cancel: Mutex<CancellationToken>,
    event_cancel: Mutex<Option<CancellationToken>>,
}

impl PersistentAudioPlayer {
    pub fn new(proxy_url: impl Into<String>) -> Result<Self, String> {
        let http = global_http_client()?;

        Ok(Self {
            inner: RwLock::new(PlaybackInner {
                track_id: None,
                stream_url: None,
                started_at: None,
                paused_at_ms: 0,
            }),
            http,
            proxy_url: proxy_url.into(),
            generation: AtomicU64::new(0),
            playing: AtomicBool::new(false),
            proxy_cancel: Mutex::new(CancellationToken::new()),
            event_cancel: Mutex::new(None),
        })
    }

    pub async fn load_and_play(&self, track_id: String, stream_url: String) -> PlaybackSnapshot {
        self.flush_codec_buffers().await;

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut inner = self.inner.write().await;
            inner.track_id = Some(track_id);
            inner.stream_url = Some(stream_url);
            inner.started_at = Some(Instant::now());
            inner.paused_at_ms = 0;
        }
        self.playing.store(true, Ordering::Release);

        self.snapshot_with_generation(generation).await
    }

    pub async fn pause(&self) -> PlaybackSnapshot {
        let position = self.position_ms().await;
        {
            let mut inner = self.inner.write().await;
            inner.started_at = None;
            inner.paused_at_ms = position;
        }
        self.playing.store(false, Ordering::Release);
        self.snapshot().await
    }

    pub async fn resume(&self) -> PlaybackSnapshot {
        {
            let mut inner = self.inner.write().await;
            inner.started_at = Some(Instant::now());
        }
        self.playing.store(true, Ordering::Release);
        self.snapshot().await
    }

    pub async fn stop(&self) -> PlaybackSnapshot {
        self.flush_codec_buffers().await;
        {
            let mut inner = self.inner.write().await;
            inner.started_at = None;
            inner.paused_at_ms = 0;
            inner.stream_url = None;
            inner.track_id = None;
        }
        self.playing.store(false, Ordering::Release);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.snapshot().await
    }

    pub async fn flush_codec_buffers(&self) {
        let mut cancel = self.proxy_cancel.lock().await;
        cancel.cancel();
        *cancel = CancellationToken::new();
    }

    pub async fn snapshot(&self) -> PlaybackSnapshot {
        let generation = self.generation.load(Ordering::Acquire);
        self.snapshot_with_generation(generation).await
    }

    async fn snapshot_with_generation(&self, generation: u64) -> PlaybackSnapshot {
        let inner = self.inner.read().await;
        PlaybackSnapshot {
            generation,
            track_id: inner.track_id.clone(),
            stream_url: inner.stream_url.clone(),
            proxy_url: self.proxy_url.clone(),
            position_ms: position_from_inner(&inner, self.playing.load(Ordering::Acquire)),
            playing: self.playing.load(Ordering::Acquire),
        }
    }

    async fn position_ms(&self) -> u64 {
        let inner = self.inner.read().await;
        position_from_inner(&inner, self.playing.load(Ordering::Acquire))
    }

    pub async fn start_event_loop(self: Arc<Self>, window: WebviewWindow) {
        let token = CancellationToken::new();
        {
            let mut old = self.event_cancel.lock().await;
            if let Some(old_token) = old.take() {
                old_token.cancel();
            }
            *old = Some(token.clone());
        }

        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    _ = token.cancelled() => break,
                    _ = tick.tick() => {
                        if self.playing.load(Ordering::Acquire) {
                            let _ = window.emit("player://position", self.snapshot().await);
                        }
                    }
                }
            }
        });
    }

    async fn current_stream(&self) -> Option<(String, CancellationToken)> {
        let stream_url = self.inner.read().await.stream_url.clone()?;
        let token = self.proxy_cancel.lock().await.clone();
        Some((stream_url, token))
    }
}

fn position_from_inner(inner: &PlaybackInner, playing: bool) -> u64 {
    let base = inner.paused_at_ms;
    if playing {
        base + inner
            .started_at
            .map(|started| started.elapsed().as_millis() as u64)
            .unwrap_or(0)
    } else {
        base
    }
}

#[derive(Clone)]
pub struct AudioProxyState {
    pub player: Arc<PersistentAudioPlayer>,
}

pub async fn audio_proxy_handler(
    State(state): State<AudioProxyState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let Some((stream_url, cancel)) = state.player.current_stream().await else {
        return text_response(StatusCode::NOT_FOUND, "No audio loaded");
    };

    let mut request = state
        .player
        .http
        .get(stream_url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
        .header(header::REFERER, "https://www.youtube.com/")
        .header("Origin", "https://www.youtube.com");

    if let Some(range) = headers.get(header::RANGE).cloned() {
        request = request.header(header::RANGE, range);
    }

    let upstream = tokio::select! {
        _ = cancel.cancelled() => return text_response(StatusCode::NO_CONTENT, ""),
        result = request.send() => result,
    };

    let Ok(upstream) = upstream else {
        return text_response(StatusCode::BAD_GATEWAY, "Audio upstream failed");
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let stream = upstream.bytes_stream();
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;

    let response_headers = response.headers_mut();
    response_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    response_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));

    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::CACHE_CONTROL,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            response_headers.insert(name, value.clone());
        }
    }

    response
}

pub async fn audio_options_handler() -> impl IntoResponse {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range, Content-Type"),
    );
    response
}

fn text_response(status: StatusCode, body: &'static str) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response
}
