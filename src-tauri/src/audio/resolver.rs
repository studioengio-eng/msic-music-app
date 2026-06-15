use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;
use tokio::sync::mpsc;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

pub fn global_http_client() -> Result<Client, String> {
    if let Some(client) = HTTP_CLIENT.get() {
        return Ok(client.clone());
    }

    let client = Client::builder()
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(90))
        .pool_idle_timeout(Duration::from_secs(180))
        .pool_max_idle_per_host(8)
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(6))
        .user_agent("Msic/0.1 Android low-latency stream resolver")
        .build()
        .map_err(|error| format!("No se pudo crear cliente HTTP global: {error}"))?;

    let _ = HTTP_CLIENT.set(client);
    HTTP_CLIENT
        .get()
        .cloned()
        .ok_or_else(|| "Cliente HTTP global no disponible".to_string())
}

#[derive(Deserialize, Debug, Clone)]
struct PipedAudioStream {
    url: String,
    bitrate: Option<i64>,
}

#[derive(Deserialize, Debug, Clone)]
struct PipedStreamResponse {
    #[serde(rename = "audioStreams")]
    audio_streams: Option<Vec<PipedAudioStream>>,
}

#[derive(Deserialize, Debug, Clone)]
struct PipedSearchItem {
    url: Option<String>,
    #[serde(rename = "type")]
    item_type: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct PipedSearchResponse {
    items: Option<Vec<PipedSearchItem>>,
}

const PIPED_INSTANCES: &[&str] = &[
    "https://pipedapi.kavin.rocks",
    "https://api.piped.projectsegfau.lt",
    "https://pipedapi.tokhmi.xyz",
    "https://pipedapi.syncstream.org",
    "https://piped-api.garudalinux.org",
    "https://pipedapi.moomoo.me",
];

pub async fn resolve_optimized_newpipe(video_id: &str) -> Result<String, String> {
    let video_id = video_id.trim().to_string();
    if video_id.is_empty() {
        return Err("video_id vacío".to_string());
    }

    log::info!("[NewPipe Extractor] Resolviendo stream para video_id={}", video_id);

    let client = global_http_client()?;
    let (tx, mut rx) = mpsc::channel(PIPED_INSTANCES.len());

    for &instance in PIPED_INSTANCES {
        let client_clone = client.clone();
        let video_id_clone = video_id.clone();
        let tx_clone = tx.clone();
        let instance_str = instance.to_string();

        tokio::spawn(async move {
            let url = format!("{}/streams/{}", instance_str, video_id_clone);
            match client_clone.get(&url).send().await {
                Ok(response) => {
                    if response.status().is_success() {
                        if let Ok(data) = response.json::<PipedStreamResponse>().await {
                            if let Some(mut streams) = data.audio_streams {
                                streams.sort_by(|a, b| b.bitrate.unwrap_or(0).cmp(&a.bitrate.unwrap_or(0)));
                                for stream in streams {
                                    if !stream.url.starts_with("blob:") && !stream.url.is_empty() {
                                        let _ = tx_clone.send(stream.url).await;
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    log::debug!("[Piped Resolver] Error consultando {}: {:?}", instance_str, err);
                }
            }
        });
    }

    let timeout_duration = Duration::from_secs(6);
    tokio::select! {
        Some(url) = rx.recv() => {
            log::info!("[NewPipe Extractor] Stream resuelto con éxito");
            Ok(url)
        }
        _ = tokio::time::sleep(timeout_duration) => {
            log::error!("[NewPipe Extractor] Agotado el tiempo límite para resolver stream");
            Err("Agotado el tiempo límite resolviendo stream vía NewPipeExtractor".to_string())
        }
    }
}

pub async fn search_youtube_piped(query: &str) -> Result<String, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("Query vacía".to_string());
    }

    log::info!("[NewPipe Search] Buscando query='{}' en NewPipe", query);

    let client = global_http_client()?;
    let (tx, mut rx) = mpsc::channel(PIPED_INSTANCES.len());

    for &instance in PIPED_INSTANCES {
        let client_clone = client.clone();
        let query_clone = query.clone();
        let tx_clone = tx.clone();
        let instance_str = instance.to_string();

        tokio::spawn(async move {
            let url = format!("{}/search", instance_str);
            match client_clone.get(&url)
                .query(&[("q", &query_clone), ("filter", &"videos".to_string())])
                .send()
                .await 
            {
                Ok(response) => {
                    if response.status().is_success() {
                        if let Ok(data) = response.json::<PipedSearchResponse>().await {
                            if let Some(items) = data.items {
                                for item in items {
                                    if let Some(item_type) = item.item_type {
                                        if item_type == "stream" || item_type == "video" {
                                            if let Some(item_url) = item.url {
                                                if let Some(video_id) = item_url.split("v=").nth(1) {
                                                    let clean_id = video_id.split('&').next().unwrap_or("").to_string();
                                                    if !clean_id.is_empty() {
                                                        let _ = tx_clone.send(clean_id).await;
                                                        return;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    log::debug!("[Piped Search] Error consultando {}: {:?}", instance_str, err);
                }
            }
        });
    }

    let timeout_duration = Duration::from_secs(6);
    tokio::select! {
        Some(video_id) = rx.recv() => {
            log::info!("[NewPipe Search] Video ID encontrado: {}", video_id);
            Ok(video_id)
        }
        _ = tokio::time::sleep(timeout_duration) => {
            log::error!("[NewPipe Search] Agotado el tiempo límite para buscar");
            Err("Agotado el tiempo límite buscando vía NewPipeExtractor".to_string())
        }
    }
}
