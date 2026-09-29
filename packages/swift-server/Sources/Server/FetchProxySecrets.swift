import Foundation
import HTTPTypes
import NIOCore










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
