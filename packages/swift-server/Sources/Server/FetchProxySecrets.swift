import Foundation
import HTTPTypes
import NIOCore

// Request-side secret handling shared by both `/api/fetch-proxy` modes: the
// default (browser-like) route in `APIRoutes.swift` and raw mode in
// `RawFetchProxy.swift`. Each helper returns the forbidden secret when a
// masked value is used against a domain it is not scoped to; the caller
// answers 403.

/// Unmask the masked values in `source`'s header fields for `hostname`,
/// writing changed values into `target`. `Authorization: Basic` is decoded
/// first so a masked password inside the base64 is found.
func unmaskRequestHeaders(
    _ source: HTTPFields,
    into target: inout HTTPFields,
    hostname: String,
    injector: SecretInjector
) -> SecretInjector.ForbiddenInfo? {
    for field in source {
        if field.name == .authorization, field.value.lowercased().hasPrefix("basic ") {
            let basic = injector.unmaskAuthorizationBasic(value: field.value, targetHostname: hostname)
            if let forbidden = basic.forbidden { return forbidden }
            if basic.value != field.value { target[field.name] = basic.value }
            continue
        }
        switch injector.inject(text: field.value, hostname: hostname) {
        case .success(let replaced):
            if replaced != field.value { target[field.name] = replaced }
        case .domainBlocked(let secretName, let blockedHostname):
            return .init(secretName: secretName, hostname: blockedHostname)
        }
    }
    return nil
}

/// Unmask a request body. Text bodies (`isTextRequestContentType`, shared
/// with node-server) take the string path, forms the encoding-aware one;
/// binary and unlabeled bodies take the byte-safe path so non-UTF-8 bytes
/// survive. A masked value on a foreign domain is left as is, never refused:
/// conversation context often quotes masked values.
func unmaskRequestBody(
    _ body: ByteBuffer,
    contentType: String,
    hostname: String,
    injector: SecretInjector
) -> ByteBuffer {
    guard body.readableBytes > 0 else { return body }
    if isTextRequestContentType(contentType),
        let text = body.getString(at: body.readerIndex, length: body.readableBytes)
    {
        let replaced =
            isFormContentType(contentType)
            ? unmaskFormBody(text: text, hostname: hostname, injector: injector)
            : injector.injectBody(text: text, hostname: hostname)
        return replaced == text ? body : ByteBuffer(string: replaced)
    }
    guard let data = body.getData(at: body.readerIndex, length: body.readableBytes) else { return body }
    let replaced = injector.unmaskBodyBytes(bytes: data, targetHostname: hostname)
    return replaced == data ? body : ByteBuffer(data: replaced)
}

/// Apply an `x-slicc-hmac-sign` directive: sign `body` with the named
/// secret's real value and attach the signature (and timestamp, for the
/// three-part spec) under the headers the spec names.
func applyHmacSigning(
    spec: String,
    body: ByteBuffer,
    headers: inout HTTPFields,
    hostname: String,
    injector: SecretInjector
) -> SecretInjector.ForbiddenInfo? {
    let bytes = body.getBytes(at: body.readerIndex, length: body.readableBytes) ?? []
    let result = injector.signHmac(spec: spec, body: bytes, targetHostname: hostname)
    if let forbidden = result.forbidden { return forbidden }
    if let name = result.headerName, let signature = result.signatureHex, let field = HTTPField.Name(name) {
        headers[field] = signature
    }
    if let name = result.timestampHeaderName, let timestamp = result.timestampValue, let field = HTTPField.Name(name) {
        headers[field] = timestamp
    }
    return nil
}

func forbiddenSecretMessage(_ forbidden: SecretInjector.ForbiddenInfo) -> String {
    "Secret \(forbidden.secretName) is not allowed for domain \(forbidden.hostname)"
}
