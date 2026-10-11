//! An http exchange with an endpoint the host describes: over the network, http or https, or
//! over a unix socket the host names, for a service a container reaches no other way.

use std::error::Error;
use std::path::{Path, PathBuf};

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::header::{HeaderValue, HOST};
use hyper::{Request, Response, Uri};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::net::UnixStream;
use url::Url;

pub type Net = Client<HttpsConnector<HttpConnector>, Full<Bytes>>;

/// Mozilla's roots, fixed in the binary, over ring: a named provider rather than whichever
/// one rustls would take as its default.
pub fn https_client() -> Net {
    let connector = HttpsConnectorBuilder::new()
        .with_provider_and_webpki_roots(rustls::crypto::ring::default_provider())
        .expect("ring supports the default protocol versions")
        .https_or_http()
        .enable_http1()
        .build();
    Client::builder(TokioExecutor::new()).build(connector)
}

#[derive(Clone)]
pub enum Dial {
    Net(Net),
    Socket(PathBuf),
}

pub fn socket_path(filled: &str, url: &Url) -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(filled);
    if !path.is_absolute() {
        return Err("socket is an absolute path");
    }
    if url.scheme() != "http" {
        return Err("a socket is spoken to in plain http, so its url is http://");
    }
    Ok(path)
}

impl Dial {
    /// The response, or why there is none. The socket's path stays out of the reason, as the
    /// url does, since it reaches the agent.
    pub async fn send(&self, req: Request<Full<Bytes>>) -> Result<Response<Incoming>, String> {
        match self {
            Dial::Net(client) => client.request(req).await.map_err(|e| chain(&e)),
            Dial::Socket(path) => over_socket(path, req)
                .await
                .map_err(|e| format!("its socket: {e}")),
        }
    }
}

async fn over_socket(
    path: &Path,
    mut req: Request<Full<Bytes>>,
) -> Result<Response<Incoming>, String> {
    let stream = UnixStream::connect(path).await.map_err(|e| e.to_string())?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| chain(&e))?;
    tokio::spawn(connection);
    let uri = req.uri().clone();
    if let Some(host) = uri.host() {
        let host = match uri.port_u16() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        };
        let host = HeaderValue::from_str(&host).map_err(|e| e.to_string())?;
        req.headers_mut().entry(HOST).or_insert(host);
    }
    *req.uri_mut() = match uri.path_and_query() {
        Some(origin) => origin
            .as_str()
            .parse::<Uri>()
            .expect("a path and query is a uri"),
        None => Uri::from_static("/"),
    };
    sender.send_request(req).await.map_err(|e| chain(&e))
}

fn chain(e: &dyn Error) -> String {
    let mut detail = e.to_string();
    let mut cause = e.source();
    while let Some(inner) = cause {
        detail.push_str(&format!(": {inner}"));
        cause = inner.source();
    }
    detail
}
