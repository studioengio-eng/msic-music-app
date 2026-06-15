mod audio;
mod cache;
mod intelligence;
mod player_plugin;
mod tasks;

use std::{fs, sync::Arc};

use audio::player::{
    audio_options_handler, audio_proxy_handler, AudioProxyState, PersistentAudioPlayer,
    PlaybackSnapshot,
};
use audio::resolver::{resolve_optimized_newpipe, search_youtube_piped};
use cache::smart_cache::{PlaybackPayload, QueueTrack, SmartCache};
use intelligence::{
    autoplay::{official_cover_url, AutoplayEngine, CandidateTrack, LastFmImage, ScoredCandidate, TrackCandidate},
    listenbrainz::{ListenBrainzClient, LocalFallbackSeed, RecommendedRecording},
    musicbrainz::{MusicBrainzClient, MusicBrainzMetadata},
};
use tasks::manager::TaskManager;
use tasks::preload::{PreloadManager, PreloadResult};
use tauri::{Manager, State};
use tokio::sync::Mutex;

const AUDIO_PROXY_URL: &str = "http://127.0.0.1:9999/audio";

#[derive(Clone)]
struct BackendServices {
    cache: Arc<SmartCache>,
    player: Arc<PersistentAudioPlayer>,
    preload: Arc<PreloadManager>,
    musicbrainz: Arc<MusicBrainzClient>,
    listenbrainz: Arc<ListenBrainzClient>,
    autoplay: Arc<Mutex<AutoplayEngine>>,
    tasks: Arc<TaskManager>,
}

#[tauri::command(rename_all = "snake_case")]
fn get_music_files() -> Vec<String> {
    let mut files = Vec::new();
    if let Some(audio_dir) = dirs::audio_dir() {
        if let Ok(entries) = fs::read_dir(audio_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    let ext_str = ext.to_string_lossy().to_lowercase();
                    if ["mp3", "wav", "flac", "m4a", "ogg"].contains(&ext_str.as_str()) {
                        files.push(path.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    files
}

#[tauri::command]
async fn get_audio_url(
    services: State<'_, BackendServices>,
    query: String,
) -> Result<String, String> {
    if let Some(url) = services.cache.get_valid_stream(&query) {
        return Ok(url);
    }

    let resolved = resolve_youtube_query(&query).await?;
    services
        .cache
        .put_stream(resolved.video_id.clone(), resolved.stream_url.clone());
    services
        .cache
        .put_stream(query, resolved.stream_url.clone());

    Ok(resolved.stream_url)
}

#[tauri::command]
async fn player_load_stream(
    services: State<'_, BackendServices>,
    track_id: String,
    stream_url: String,
) -> Result<PlaybackSnapshot, String> {
    Ok(services.player.load_and_play(track_id, stream_url).await)
}

#[tauri::command]
async fn player_pause(services: State<'_, BackendServices>) -> Result<PlaybackSnapshot, String> {
    Ok(services.player.pause().await)
}

#[tauri::command]
async fn player_resume(services: State<'_, BackendServices>) -> Result<PlaybackSnapshot, String> {
    Ok(services.player.resume().await)
}

#[tauri::command]
async fn player_stop(services: State<'_, BackendServices>) -> Result<PlaybackSnapshot, String> {
    Ok(services.player.stop().await)
}

#[tauri::command]
async fn player_snapshot(services: State<'_, BackendServices>) -> Result<PlaybackSnapshot, String> {
    Ok(services.player.snapshot().await)
}

#[tauri::command]
async fn trigger_preload(
    services: State<'_, BackendServices>,
    track_id: String,
) -> Result<Option<PreloadResult>, String> {
    Ok(services.preload.trigger_preload(track_id).await)
}

#[tauri::command]
async fn cancel_preload(services: State<'_, BackendServices>) -> Result<(), String> {
    services.preload.cancel_active().await;
    Ok(())
}

#[tauri::command]
async fn cache_link_youtube_mbid(
    services: State<'_, BackendServices>,
    youtube_id: String,
    mbid: String,
) -> Result<(), String> {
    services.cache.put_youtube_mbid(youtube_id, mbid);
    Ok(())
}

#[tauri::command]
async fn cache_get_mbid_for_youtube(
    services: State<'_, BackendServices>,
    youtube_id: String,
) -> Result<Option<String>, String> {
    Ok(services.cache.get_youtube_mbid(&youtube_id))
}

#[tauri::command]
async fn cache_purge_expired_streams(services: State<'_, BackendServices>) -> Result<(), String> {
    services.cache.purge_expired_streams();
    Ok(())
}

#[tauri::command]
async fn cache_clear_transient_streams(services: State<'_, BackendServices>) -> Result<(), String> {
    services.cache.clear_transient_streams();
    Ok(())
}

#[tauri::command]
async fn resolve_optimized_stream(video_id: String) -> Result<String, String> {
    resolve_optimized_newpipe(&video_id).await
}

#[tauri::command]
async fn set_hot_queue(
    services: State<'_, BackendServices>,
    queue: Vec<QueueTrack>,
    current_index: usize,
) -> Result<(), String> {
    let cache = Arc::clone(&services.cache);
    tokio::spawn(async move {
        cache.ensure_hot_queue(queue, current_index).await;
    });
    Ok(())
}

#[tauri::command]
async fn consume_hot_track(
    services: State<'_, BackendServices>,
    track: QueueTrack,
    queue: Vec<QueueTrack>,
    consumed_index: usize,
) -> Result<PlaybackPayload, String> {
    services.tasks.cancel_active_extraction().await;
    let cache = Arc::clone(&services.cache);
    let task_cache = Arc::clone(&cache);
    let handle = Arc::clone(&services.tasks)
        .spawn_cancellable(async move { task_cache.payload_for_track(track).await })
        .await;

    let payload = match handle.await {
        Ok(result) => result?,
        Err(error) if error.is_cancelled() => {
            return Err("Reproducción cancelada por nuevo skip".to_string());
        }
        Err(error) => return Err(format!("Tarea de reproducción falló: {error}")),
    };

    cache.spawn_refill(queue, consumed_index);
    Ok(payload)
}

#[tauri::command]
async fn fetch_musicbrainz_metadata(
    services: State<'_, BackendServices>,
    title: String,
    artist: String,
) -> Result<MusicBrainzMetadata, String> {
    services.musicbrainz.fetch_metadata(&title, &artist).await
}

#[tauri::command]
async fn listenbrainz_recommend(
    services: State<'_, BackendServices>,
    recording_mbid: String,
    fallback_tracks: Vec<CandidateTrack>,
    genres: Vec<String>,
) -> Result<Vec<RecommendedRecording>, String> {
    let fallback = LocalFallbackSeed {
        recent_tracks: fallback_tracks.into(),
        genres,
    };
    Ok(services
        .listenbrainz
        .recommend_recordings(&recording_mbid, fallback)
        .await)
}

#[tauri::command]
async fn listenbrainz_similar_artists(
    services: State<'_, BackendServices>,
    artist_mbid: String,
    fallback_artists: Vec<String>,
) -> Result<Vec<String>, String> {
    Ok(services
        .listenbrainz
        .similar_artists(&artist_mbid, fallback_artists)
        .await)
}

#[tauri::command]
async fn autoplay_remember(
    services: State<'_, BackendServices>,
    track_id: String,
    artist_id: String,
) -> Result<(), String> {
    services
        .autoplay
        .lock()
        .await
        .remember_played(track_id, artist_id);
    Ok(())
}

#[tauri::command]
async fn autoplay_remember_track(
    services: State<'_, BackendServices>,
    title: String,
    artist: String,
) -> Result<(), String> {
    services.autoplay.lock().await.remember_track(title, artist);
    Ok(())
}

#[tauri::command]
async fn autoplay_select_lastfm(
    services: State<'_, BackendServices>,
    candidates: Vec<TrackCandidate>,
) -> Result<Option<TrackCandidate>, String> {
    Ok(services.autoplay.lock().await.select_next_track(candidates))
}

#[tauri::command]
async fn lastfm_official_cover_url(images: Vec<LastFmImage>) -> Result<String, String> {
    Ok(official_cover_url(&images))
}

#[tauri::command]
async fn autoplay_select_next(
    services: State<'_, BackendServices>,
    candidates: Vec<CandidateTrack>,
    preferred_genres: Vec<String>,
) -> Result<Option<ScoredCandidate>, String> {
    Ok(services
        .autoplay
        .lock()
        .await
        .select_next(candidates, &preferred_genres))
}

#[tauri::command]
async fn autoplay_recent_tracks(services: State<'_, BackendServices>) -> Result<Vec<String>, String> {
    Ok(services.autoplay.lock().await.recent_track_ids())
}

#[tauri::command]
async fn autoplay_recent_artists(services: State<'_, BackendServices>) -> Result<Vec<String>, String> {
    Ok(services.autoplay.lock().await.recent_artist_ids())
}

#[derive(Debug)]
struct ResolvedYoutubeStream {
    video_id: String,
    stream_url: String,
}

async fn resolve_youtube_query(query: &str) -> Result<ResolvedYoutubeStream, String> {
    log::info!("Resolviendo stream prioritario para: {query}");

    let video_id = search_youtube_piped(query).await?;
    let stream_url = resolve_optimized_newpipe(&video_id).await?;

    Ok(ResolvedYoutubeStream {
        video_id,
        stream_url,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cache = Arc::new(SmartCache::new());
    let player = match PersistentAudioPlayer::new(AUDIO_PROXY_URL) {
        Ok(player) => Arc::new(player),
        Err(error) => {
            log::error!("No se pudo inicializar el reproductor persistente: {error}");
            return;
        }
    };
    let preload = Arc::new(PreloadManager::new(Arc::clone(&cache)));
    let musicbrainz = match MusicBrainzClient::new(Arc::clone(&cache)) {
        Ok(client) => Arc::new(client),
        Err(error) => {
            log::error!("No se pudo inicializar MusicBrainzClient: {error}");
            return;
        }
    };
    let listenbrainz = match ListenBrainzClient::new(Arc::clone(&cache)) {
        Ok(client) => Arc::new(client),
        Err(error) => {
            log::error!("No se pudo inicializar ListenBrainzClient: {error}");
            return;
        }
    };
    let services = BackendServices {
        cache,
        player,
        preload,
        musicbrainz,
        listenbrainz,
        autoplay: Arc::new(Mutex::new(AutoplayEngine::new())),
        tasks: Arc::new(TaskManager::new()),
    };

    let run_result = tauri::Builder::default()
        .manage(services.clone())
        .setup(move |app| {
            let player = Arc::clone(&services.player);
            if let Some(window) = app.get_webview_window("main") {
                tauri::async_runtime::spawn(Arc::clone(&player).start_event_loop(window));
            }

            tauri::async_runtime::spawn(async move {
                let router = axum::Router::new()
                    .route("/audio", axum::routing::get(audio_proxy_handler))
                    .route("/audio", axum::routing::options(audio_options_handler))
                    .with_state(AudioProxyState { player });

                match tokio::net::TcpListener::bind("127.0.0.1:9999").await {
                    Ok(listener) => {
                        if let Err(error) = axum::serve(listener, router).await {
                            log::error!("Proxy de audio detenido: {error}");
                        }
                    }
                    Err(error) => log::error!("No se pudo iniciar el proxy de audio: {error}"),
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(player_plugin::init())
        .invoke_handler(tauri::generate_handler![
            get_music_files,
            get_audio_url,
            player_load_stream,
            player_pause,
            player_resume,
            player_stop,
            player_snapshot,
            trigger_preload,
            cancel_preload,
            cache_link_youtube_mbid,
            cache_get_mbid_for_youtube,
            cache_purge_expired_streams,
            cache_clear_transient_streams,
            resolve_optimized_stream,
            set_hot_queue,
            consume_hot_track,
            fetch_musicbrainz_metadata,
            listenbrainz_recommend,
            listenbrainz_similar_artists,
            autoplay_remember,
            autoplay_remember_track,
            autoplay_select_next,
            autoplay_select_lastfm,
            lastfm_official_cover_url,
            autoplay_recent_tracks,
            autoplay_recent_artists
        ])
        .run(tauri::generate_context!());

    if let Err(error) = run_result {
        log::error!("Tauri finalizó con error controlado: {error}");
    }
}
