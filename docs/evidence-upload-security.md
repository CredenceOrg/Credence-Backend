# Evidence Upload Security

## Overview

The evidence upload endpoint (`POST /api/evidence/upload`) has been security-hardened to prevent denial-of-service attacks and storage abuse. All validation occurs at the edge before bytes are persisted to storage.

## Security Measures

### 1. File Size Limits

- **Maximum file size**: 10MB per file
- **Maximum field size**: 1MB for form fields
- **Enforcement**: Multer middleware rejects oversized files before processing
- **Response**: HTTP 413 (Payload Too Large) with `FileTooLarge` code

### 2. File Count Limits

- **Maximum files per request**: 5 files
- **Enforcement**: Multer middleware rejects requests exceeding the limit
- **Response**: HTTP 400 (Bad Request) with `TooManyFiles` code

### 3. MIME Type Allow-List

Only the following MIME types are accepted:

- `image/jpeg` - JPEG images
- `image/png` - PNG images
- `image/gif` - GIF images
- `image/webp` - WebP images
- `application/pdf` - PDF documents
- `text/plain` - Plain text files
- `application/json` - JSON files
- `text/csv` - CSV files

**Enforcement**: File filter validates declared MIME type against allow-list
**Response**: HTTP 415 (Unsupported Media Type) with `InvalidMimeType` code

### 4. Extension Allow-List

Only the following file extensions are accepted:

- `.jpg`, `.jpeg` - JPEG images
- `.png` - PNG images
- `.gif` - GIF images
- `.webp` - WebP images
- `.pdf` - PDF documents
- `.txt` - Plain text files
- `.json` - JSON files
- `.csv` - CSV files

**Enforcement**: File filter validates file extension against allow-list
**Response**: HTTP 415 (Unsupported Media Type) with `InvalidFileType` code

### 5. Magic-Number Validation

To prevent MIME type spoofing, the actual file content is validated against declared MIME types using magic number signatures:

- **JPEG**: `FF D8 FF`
- **PNG**: `89 50 4E 47 0D 0A 1A 0A`
- **GIF**: `47 49 46 38`
- **WebP**: `52 49 46 46`
- **PDF**: `25 50 44 46`

**Enforcement**: File filter checks file header bytes against expected signature
**Response**: HTTP 400 (Bad Request) with `ContentMismatch` code

**Note**: MIME types without magic number signatures (e.g., `text/plain`, `application/json`) skip this validation.

### 6. Temp File Cleanup

- **Storage strategy**: Memory storage (multer.memoryStorage())
- **Benefit**: No temporary files are written to disk, eliminating cleanup concerns
- **Rejection handling**: Failed uploads are automatically cleaned from memory

### 7. Metrics

Prometheus metrics track upload acceptance and rejection:

- `evidence_upload_accepted_total` - Total accepted uploads
- `evidence_upload_rejected_total{reason}` - Total rejected uploads by reason:
  - `file_too_large` - File exceeded size limit
  - `too_many_files` - Request exceeded file count limit
  - `field_too_large` - Form field exceeded size limit
  - `invalid_extension` - File extension not in allow-list
  - `invalid_mime_type` - MIME type not in allow-list
  - `magic_number_mismatch` - File content doesn't match declared MIME type
  - `no_files` - No files provided in request
  - `multer_error` - General multer upload error
  - `storage_error` - Error during storage persistence

## API Usage

### Request

```http
POST /api/evidence/upload
Content-Type: multipart/form-data
Authorization: Bearer <token>

files: <file1>
files: <file2>
evidenceId: <optional-evidence-id>
```

### Success Response (201)

```json
{
  "evidence_id": "uuid",
  "encryptedBlob": "...",
  "iv": "...",
  "authTag": "...",
  "wrappedDek": "...",
  "wrappedDekIv": "...",
  "wrappedDekAuthTag": "...",
  "uploaderId": "user-id",
  "tenantId": "tenant-id",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "kek_version": 1,
  "deletedAt": null,
  "legalHold": false,
  "shreddedAt": null
}
```

### Error Responses

#### File Too Large (413)

```json
{
  "error": "PayloadTooLarge",
  "code": "FileTooLarge",
  "message": "Evidence file exceeds maximum size of 10MB."
}
```

#### Too Many Files (400)

```json
{
  "error": "BadRequest",
  "code": "TooManyFiles",
  "message": "Maximum 5 files allowed per request."
}
```

#### Invalid MIME Type (415)

```json
{
  "error": "UnsupportedMediaType",
  "code": "InvalidMimeType",
  "message": "MIME type application/x-msdownload is not allowed. Allowed types: image/jpeg, image/png, ..."
}
```

#### Invalid Extension (415)

```json
{
  "error": "UnsupportedMediaType",
  "code": "InvalidFileType",
  "message": "File extension .exe is not allowed. Allowed extensions: .jpg, .jpeg, .png, ..."
}
```

#### Content Mismatch (400)

```json
{
  "error": "BadRequest",
  "code": "ContentMismatch",
  "message": "File content does not match declared MIME type image/jpeg"
}
```

#### No Files (400)

```json
{
  "error": "BadRequest",
  "code": "NoFiles",
  "message": "At least one file is required in the \"files\" field."
}
```

## Testing

Comprehensive tests cover all validation paths:

- Oversized file rejection
- Disallowed MIME type rejection
- Too many files rejection
- Invalid extension rejection
- Magic number mismatch rejection
- No files provided
- Valid upload acceptance
- Metrics verification
- Edge cases (zero-byte files, concurrent uploads)

Run tests with:

```bash
npm run test -- evidence
```

## Migration Notes

### Breaking Changes

The endpoint signature has changed from accepting a JSON body with `rawData` string to accepting multipart form data with file uploads:

**Old format:**
```json
{
  "evidenceId": "optional-id",
  "rawData": "base64-encoded-string"
}
```

**New format:**
```
Content-Type: multipart/form-data
files: <binary file>
evidenceId: <optional-id>
```

### Client Migration

Clients must update their upload logic:

1. Change from JSON body to multipart form data
2. Send files as binary data instead of base64 strings
3. Ensure file extensions and MIME types match allow-list
4. Handle new error codes appropriately

### Backward Compatibility

This is a breaking change. Existing clients using the old JSON-based upload will need to be updated.

## Security Considerations

### Why Memory Storage?

Using `multer.memoryStorage()` instead of disk storage provides:

1. **Automatic cleanup**: No temp files to manage
2. **Faster validation**: Content is already in memory for magic number checks
3. **Reduced attack surface**: No disk I/O or file system permissions to worry about
4. **Simpler error handling**: Rejected uploads don't leave artifacts

### Why Magic Number Validation?

MIME type spoofing is a common attack vector where malicious files are given benign extensions. Magic number validation ensures:

1. **Content integrity**: File content matches declared type
2. **Prevents polyglot files**: Files that could be interpreted as multiple types
3. **Defense in depth**: Even if extension validation is bypassed, content validation catches it

### Why Allow-Lists?

Allow-listing (vs. block-listing) provides:

1. **Explicit security**: Only known-safe types are accepted
2. **Easier maintenance**: New threats don't require updating block-lists
3. **Clear documentation**: Accepted types are explicitly defined
4. **Reduced attack surface**: Unknown types are rejected by default

## Monitoring

Monitor the following metrics to detect abuse:

- `evidence_upload_rejected_total{reason="file_too_large"}` - Spikes may indicate DoS attempts
- `evidence_upload_rejected_total{reason="magic_number_mismatch"}` - Spikes may indicate spoofing attacks
- `evidence_upload_rejected_total{reason="invalid_extension"}` - Spikes may indicate probing for allowed types
- `evidence_upload_accepted_total` - Baseline for normal usage

Set up alerts on:
- Sudden increases in rejection rates
- Rejection rates exceeding 10% of total uploads
- Specific rejection reasons showing unusual patterns

## Future Enhancements

Potential security improvements:

1. **Virus scanning**: Integrate with antivirus/antimalware scanning
2. **Content analysis**: Extract metadata (EXIF, PDF info) for additional validation
3. **Rate limiting**: Per-user or per-IP upload rate limits
4. **Quota enforcement**: Per-tenant storage quotas
5. **File transformation**: Convert all uploads to standardized formats
6. **Content addressable storage**: Deduplicate identical files
7. **Retention policies**: Automatic cleanup of old evidence
