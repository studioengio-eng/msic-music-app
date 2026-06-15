use rusty_ytdl::{Video, VideoOptions, VideoQuality, VideoSearchOptions};

#[tokio::main]
async fn main() {
    let options = VideoOptions {
        quality: VideoQuality::LowestAudio,
        filter: VideoSearchOptions::Audio,
        ..Default::default()
    };
    let video = Video::new_with_options("dQw4w9WgXcQ", options).unwrap();
    let stream = video.streams().into_iter().find(|s| s.mime_type.contains("mp4") || s.mime_type.contains("m4a"));
    match stream {
        Some(s) => println!("Found: {}", s.mime_type),
        None => println!("Not found")
    }
}
