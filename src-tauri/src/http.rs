//! Tiny HTTP helpers shared by the extension bridge and the service API:
//! request hardening for localhost servers and a minimal client.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Checks that a request to one of our localhost servers can't come from a
/// web page:
/// * the custom `header` can't be sent cross-origin without a CORS preflight,
///   which we never approve;
/// * the `Host` header must be the loopback address, which defeats DNS
///   rebinding (a page whose own domain resolves to 127.0.0.1);
/// * requests carrying an `Origin` from a web page are refused.
pub fn trusted(req: &tiny_http::Request, header: &'static str, port: u16) -> bool {
    fn header_value(req: &tiny_http::Request, name: &'static str) -> Option<String> {
        req.headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str().to_ascii_lowercase())
    }
    let get = |name: &'static str| header_value(req, name);
    let host_ok = get("Host").is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    // Extensions send their own origin (chrome-extension://, moz-extension://).
    let origin_ok = get("Origin").is_none_or(|o| o.contains("-extension://"));
    get(header).is_some() && host_ok && origin_ok
}

pub fn query_param<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    url.split_once('?')?
        .1
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v)
}

/// Decodes `%xx` escapes and `+` in a query value.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                        continue;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn json_header() -> tiny_http::Header {
    tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap()
}

/// Minimal blocking HTTP/1.1 client for our own localhost servers.
/// Returns the status code and body.
pub fn request(port: u16, method: &str, path: &str, header: &str, body: Option<&[u8]>, timeout: Duration) -> Result<(u16, Vec<u8>), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();
    let body = body.unwrap_or(&[]);
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{header}: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    stream.write_all(body).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("malformed response")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("malformed status line")?;
    let mut body = raw[split + 4..].to_vec();
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        body = dechunk(&body);
    }
    Ok((status, body))
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(pos) = b.windows(2).position(|w| w == b"\r\n") {
        let len = usize::from_str_radix(std::str::from_utf8(&b[..pos]).unwrap_or("0").trim(), 16).unwrap_or(0);
        if len == 0 || b.len() < pos + 2 + len {
            break;
        }
        out.extend_from_slice(&b[pos + 2..pos + 2 + len]);
        b = &b[(pos + 4 + len).min(b.len())..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes() {
        assert_eq!(percent_decode("https%3A%2F%2Fx.com%2Fa%20b+c"), "https://x.com/a b c");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn dechunks() {
        assert_eq!(dechunk(b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"), b"abcde");
    }
}
