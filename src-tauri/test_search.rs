use rusty_ytdl::search::YouTube;

#[tokio::main]
async fn main() {
    let yt = YouTube::new().unwrap();
    let res = yt.search_one("test", None).await.unwrap().unwrap();
    match res {
        rusty_ytdl::search::SearchResult::Video(v) => println!("Video: {}", v.id),
        _ => println!("Not a video"),
    }
}
