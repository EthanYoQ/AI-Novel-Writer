// This helper is deliberately native instead of a Node fs fallback. Every path
// component is opened from a trusted directory descriptor with openat(2) and
// O_NOFOLLOW, so a symlink replacement cannot redirect a later operation out of
// the capability root. The JSON wire protocol is identical to the Darwin helper
// so the main process keeps one validation contract on every platform.

#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static const size_t kMaxPathCharacters = 32000;
static const size_t kMaxSegments = 256;
static const uint64_t kMaxTextBytes = 64u * 1024u * 1024u;
static const size_t kMaxDirectoryEntries = 16384;
static const size_t kMaxRequestBytes = 100u * 1024u * 1024u;
static const size_t kMaxCommandBytes = 4096;

static const char *const kInvalidPath = "SECURE_FS_INVALID_PATH";
static const char *const kNotFound = "SECURE_FS_NOT_FOUND";
static const char *const kReparsePoint = "SECURE_FS_REPARSE_POINT";
static const char *const kOpenFailed = "SECURE_FS_OPEN_FAILED";
static const char *const kWriteFailed = "SECURE_FS_WRITE_FAILED";
static const char *const kRootChanged = "SECURE_FS_ROOT_CHANGED";
static const char *const kFileTooLarge = "SECURE_FS_FILE_TOO_LARGE";
static const char *const kDirectoryTooLarge = "SECURE_FS_DIRECTORY_TOO_LARGE";
static const char *const kInvalidText = "SECURE_FS_INVALID_TEXT";
static const char *const kInvalidOperation = "SECURE_FS_INVALID_OPERATION";
static const char *const kRequestTooLarge = "SECURE_FS_REQUEST_TOO_LARGE";
static const char *const kCancelled = "SECURE_FS_CANCELLED";
static const char *const kHelperFailed = "SECURE_FS_HELPER_FAILED";

// ---------------------------------------------------------------------------
// Output buffer
// ---------------------------------------------------------------------------

typedef struct {
  char *bytes;
  size_t length;
  size_t capacity;
} Buffer;

/** Grows the buffer so at least `extra` more bytes and a NUL terminator fit. */
static int BufferReserve(Buffer *buffer, size_t extra) {
  if (buffer->length + extra + 1 <= buffer->capacity) return 1;
  size_t capacity = buffer->capacity ? buffer->capacity : 4096;
  while (capacity < buffer->length + extra + 1) {
    if (capacity > (size_t)-1 / 2) return 0;
    capacity *= 2;
  }
  char *grown = realloc(buffer->bytes, capacity);
  if (!grown) return 0;
  buffer->bytes = grown;
  buffer->capacity = capacity;
  return 1;
}

/** Appends raw bytes and keeps the buffer NUL-terminated. */
static int BufferAppend(Buffer *buffer, const char *bytes, size_t length) {
  if (!BufferReserve(buffer, length)) return 0;
  memcpy(buffer->bytes + buffer->length, bytes, length);
  buffer->length += length;
  buffer->bytes[buffer->length] = '\0';
  return 1;
}

/** Appends a NUL-terminated literal. */
static int BufferAppendLiteral(Buffer *buffer, const char *literal) {
  return BufferAppend(buffer, literal, strlen(literal));
}

/** Escapes one already-decoded UTF-8 byte sequence for a JSON string value. */
static int BufferAppendJsonString(Buffer *buffer, const char *bytes, size_t length) {
  if (!BufferAppendLiteral(buffer, "\"")) return 0;
  for (size_t index = 0; index < length; index++) {
    unsigned char value = (unsigned char)bytes[index];
    if (value == '"' || value == '\\') {
      char escaped[2] = { '\\', (char)value };
      if (!BufferAppend(buffer, escaped, 2)) return 0;
      continue;
    }
    if (value < 0x20) {
      char escaped[6] = { '\\', 'u', '0', '0', 0, 0 };
      static const char *const hex = "0123456789abcdef";
      escaped[4] = hex[(value >> 4) & 0xF];
      escaped[5] = hex[value & 0xF];
      if (!BufferAppend(buffer, escaped, 6)) return 0;
      continue;
    }
    if (!BufferAppend(buffer, (const char *)&bytes[index], 1)) return 0;
  }
  return BufferAppendLiteral(buffer, "\"");
}

/** Writes one complete response line; an empty buffer falls back to a failure code. */
static void WriteResponse(Buffer *response) {
  if (!response->bytes) {
    static const char fallback[] = "{\"ok\":false,\"code\":\"SECURE_FS_HELPER_FAILED\"}\n";
    fwrite(fallback, 1, sizeof(fallback) - 1, stdout);
    fflush(stdout);
    return;
  }
  fwrite(response->bytes, 1, response->length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

/** Writes a failure response for the given SECURE_FS_* code. */
static void WriteFailure(const char *code) {
  Buffer response = { NULL, 0, 0 };
  BufferAppendLiteral(&response, "{\"ok\":false,\"code\":");
  BufferAppendJsonString(&response, code ? code : kHelperFailed, strlen(code ? code : kHelperFailed));
  BufferAppendLiteral(&response, "}");
  WriteResponse(&response);
  free(response.bytes);
}

/** Writes a fixed, already-serialised response body. */
static void EmitLiteral(const char *literal, size_t length) {
  fwrite(literal, 1, length, stdout);
  fflush(stdout);
}

/** Writes the plain success response. */
static void WriteSuccess(void) {
  static const char payload[] = "{\"ok\":true}\n";
  EmitLiteral(payload, sizeof(payload) - 1);
}

/** Writes the two-phase handshake signal; the commit command has not arrived yet. */
static void WriteReady(void) {
  static const char payload[] = "{\"ok\":true,\"phase\":\"ready\"}\n";
  EmitLiteral(payload, sizeof(payload) - 1);
}

/** Writes the exists response for a boolean answer. */
static void WriteExists(int exists) {
  static const char present[] = "{\"ok\":true,\"exists\":true}\n";
  static const char absent[] = "{\"ok\":true,\"exists\":false}\n";
  if (exists) EmitLiteral(present, sizeof(present) - 1);
  else EmitLiteral(absent, sizeof(absent) - 1);
}

// ---------------------------------------------------------------------------
// Minimal JSON reader
// ---------------------------------------------------------------------------

typedef struct {
  const char *pointer;
  size_t length;
  char *owned;
} Slice;

typedef enum {
  JsonNull,
  JsonBoolean,
  JsonNumber,
  JsonString,
  JsonObject,
} JsonType;

typedef struct JsonMember {
  char *key;
  struct JsonValue *value;
} JsonMember;

typedef struct JsonValue {
  JsonType type;
  int boolean;
  double number;
  Slice string;
  JsonMember *members;
  size_t memberCount;
} JsonValue;

typedef struct {
  const char *cursor;
  const char *end;
  const char *error;
} Parser;

/** Advances past JSON insignificant whitespace. */
static void SkipWhitespace(Parser *parser) {
  while (parser->cursor < parser->end) {
    char value = *parser->cursor;
    if (value != ' ' && value != '\t' && value != '\n' && value != '\r') break;
    parser->cursor++;
  }
}

/** Encodes one Unicode code point as 1-4 UTF-8 bytes; surrogate halves never reach here. */
static int AppendUtf8(Buffer *buffer, uint32_t code) {
  if (code > 0x10FFFF) return 0;
  char bytes[4];
  size_t length = 0;
  if (code < 0x80) {
    bytes[length++] = (char)code;
  } else if (code < 0x800) {
    bytes[length++] = (char)(0xC0 | (code >> 6));
    bytes[length++] = (char)(0x80 | (code & 0x3F));
  } else if (code < 0x10000) {
    bytes[length++] = (char)(0xE0 | (code >> 12));
    bytes[length++] = (char)(0x80 | ((code >> 6) & 0x3F));
    bytes[length++] = (char)(0x80 | (code & 0x3F));
  } else {
    bytes[length++] = (char)(0xF0 | (code >> 18));
    bytes[length++] = (char)(0x80 | ((code >> 12) & 0x3F));
    bytes[length++] = (char)(0x80 | ((code >> 6) & 0x3F));
    bytes[length++] = (char)(0x80 | (code & 0x3F));
  }
  return BufferAppend(buffer, bytes, length);
}

/** Decodes four hex digits, or UINT32_MAX when any digit is invalid. */
static uint32_t Hex4(const char *digits) {
  uint32_t value = 0;
  for (int index = 0; index < 4; index++) {
    char digit = digits[index];
    value <<= 4;
    if (digit >= '0' && digit <= '9') value |= (uint32_t)(digit - '0');
    else if (digit >= 'a' && digit <= 'f') value |= (uint32_t)(digit - 'a' + 10);
    else if (digit >= 'A' && digit <= 'F') value |= (uint32_t)(digit - 'A' + 10);
    else return UINT32_MAX;
  }
  return value;
}

/** Decodes an already-delimited JSON string body in one pass. */
static int DecodeStringBody(const char *scan, const char *limit, Slice *output) {
  Buffer decoded = { NULL, 0, 0 };
  while (scan < limit) {
    if (*scan != '\\') {
      if ((unsigned char)*scan < 0x20) goto failed;
      if (!BufferAppend(&decoded, scan, 1)) goto failed;
      scan++;
      continue;
    }
    scan++;
    if (scan >= limit) goto failed;
    char marker = *scan++;
    switch (marker) {
      case '"': case '\\': case '/':
        if (!BufferAppend(&decoded, &marker, 1)) goto failed;
        break;
      case 'b': if (!BufferAppendLiteral(&decoded, "\b")) goto failed; break;
      case 'f': if (!BufferAppendLiteral(&decoded, "\f")) goto failed; break;
      case 'n': if (!BufferAppendLiteral(&decoded, "\n")) goto failed; break;
      case 'r': if (!BufferAppendLiteral(&decoded, "\r")) goto failed; break;
      case 't': if (!BufferAppendLiteral(&decoded, "\t")) goto failed; break;
      case 'u': {
        if (limit - scan < 4) goto failed;
        uint32_t code = Hex4(scan);
        if (code == UINT32_MAX) goto failed;
        scan += 4;
        if (code >= 0xD800 && code <= 0xDBFF) {
          if (limit - scan < 6 || scan[0] != '\\' || scan[1] != 'u') goto failed;
          uint32_t low = Hex4(scan + 2);
          if (low == UINT32_MAX || low < 0xDC00 || low > 0xDFFF) goto failed;
          scan += 6;
          code = 0x10000u + ((code - 0xD800u) << 10) + (low - 0xDC00u);
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
          goto failed;
        }
        if (!AppendUtf8(&decoded, code)) goto failed;
        break;
      }
      default:
        goto failed;
    }
  }
  if (!BufferReserve(&decoded, 0)) goto failed;
  decoded.bytes[decoded.length] = '\0';
  output->pointer = decoded.bytes;
  output->length = decoded.length;
  output->owned = decoded.bytes;
  return 1;
failed:
  free(decoded.bytes);
  return 0;
}

/** Locates the closing quote, then delegates decoding. Plain input stays zero-copy. */
static int ParseJsonString(Parser *parser, Slice *output) {
  if (parser->cursor >= parser->end || *parser->cursor != '"') return 0;
  parser->cursor++;
  const char *start = parser->cursor;
  int escaped = 0;
  while (parser->cursor < parser->end) {
    char value = *parser->cursor;
    if (value == '"') break;
    if (value == '\\') {
      escaped = 1;
      if (parser->cursor + 1 >= parser->end) return 0;
      parser->cursor += 2;
      continue;
    }
    if ((unsigned char)value < 0x20) return 0;
    parser->cursor++;
  }
  if (parser->cursor >= parser->end) return 0;
  const char *limit = parser->cursor;
  parser->cursor++;
  if (!escaped) {
    output->pointer = start;
    output->length = (size_t)(limit - start);
    output->owned = NULL;
    return 1;
  }
  return DecodeStringBody(start, limit, output);
}

/** Parses one JSON value; the protocol only uses objects, strings, booleans, and numbers. */
static int ParseJsonValue(Parser *parser, JsonValue *output);

/** Parses a JSON object into flat key/value members. */
static int ParseJsonObject(Parser *parser, JsonValue *output) {
  if (parser->cursor >= parser->end || *parser->cursor != '{') return 0;
  parser->cursor++;
  output->type = JsonObject;
  output->members = NULL;
  output->memberCount = 0;
  size_t capacity = 0;
  SkipWhitespace(parser);
  if (parser->cursor < parser->end && *parser->cursor == '}') {
    parser->cursor++;
    return 1;
  }
  for (;;) {
    SkipWhitespace(parser);
    Slice key = { NULL, 0, NULL };
    if (!ParseJsonString(parser, &key)) return 0;
    SkipWhitespace(parser);
    if (parser->cursor >= parser->end || *parser->cursor != ':') return 0;
    parser->cursor++;
    SkipWhitespace(parser);
    JsonValue *value = calloc(1, sizeof(JsonValue));
    if (!value) return 0;
    if (!ParseJsonValue(parser, value)) {
      free(value);
      return 0;
    }
    if (output->memberCount == capacity) {
      size_t grown = capacity ? capacity * 2 : 8;
      JsonMember *members = realloc(output->members, grown * sizeof(JsonMember));
      if (!members) {
        free(value);
        return 0;
      }
      output->members = members;
      capacity = grown;
    }
    char *keyCopy = malloc(key.length + 1);
    if (!keyCopy) {
      free(value);
      return 0;
    }
    memcpy(keyCopy, key.pointer, key.length);
    keyCopy[key.length] = '\0';
    free(key.owned);
    output->members[output->memberCount].key = keyCopy;
    output->members[output->memberCount].value = value;
    output->memberCount++;
    SkipWhitespace(parser);
    if (parser->cursor >= parser->end) return 0;
    if (*parser->cursor == ',') {
      parser->cursor++;
      continue;
    }
    if (*parser->cursor == '}') {
      parser->cursor++;
      return 1;
    }
    return 0;
  }
}

static int ParseJsonValue(Parser *parser, JsonValue *output) {
  SkipWhitespace(parser);
  if (parser->cursor >= parser->end) return 0;
  char leading = *parser->cursor;
  if (leading == '{') return ParseJsonObject(parser, output);
  if (leading == '"') {
    output->type = JsonString;
    return ParseJsonString(parser, &output->string);
  }
  if (leading == 't') {
    if ((size_t)(parser->end - parser->cursor) < 4 || strncmp(parser->cursor, "true", 4) != 0) return 0;
    parser->cursor += 4;
    output->type = JsonBoolean;
    output->boolean = 1;
    return 1;
  }
  if (leading == 'f') {
    if ((size_t)(parser->end - parser->cursor) < 5 || strncmp(parser->cursor, "false", 5) != 0) return 0;
    parser->cursor += 5;
    output->type = JsonBoolean;
    output->boolean = 0;
    return 1;
  }
  if (leading == 'n') {
    if ((size_t)(parser->end - parser->cursor) < 4 || strncmp(parser->cursor, "null", 4) != 0) return 0;
    parser->cursor += 4;
    output->type = JsonNull;
    return 1;
  }
  const char *start = parser->cursor;
  if (parser->cursor < parser->end && (*parser->cursor == '-' || *parser->cursor == '+')) parser->cursor++;
  int digits = 0;
  while (parser->cursor < parser->end && *parser->cursor >= '0' && *parser->cursor <= '9') {
    parser->cursor++;
    digits++;
  }
  if (parser->cursor < parser->end && *parser->cursor == '.') {
    parser->cursor++;
    while (parser->cursor < parser->end && *parser->cursor >= '0' && *parser->cursor <= '9') {
      parser->cursor++;
      digits++;
    }
  }
  if (!digits) return 0;
  if (parser->cursor < parser->end && (*parser->cursor == 'e' || *parser->cursor == 'E')) {
    parser->cursor++;
    if (parser->cursor < parser->end && (*parser->cursor == '-' || *parser->cursor == '+')) parser->cursor++;
    int exponentDigits = 0;
    while (parser->cursor < parser->end && *parser->cursor >= '0' && *parser->cursor <= '9') {
      parser->cursor++;
      exponentDigits++;
    }
    if (!exponentDigits) return 0;
  }
  char scratch[64];
  size_t length = (size_t)(parser->cursor - start);
  if (length >= sizeof(scratch)) return 0;
  memcpy(scratch, start, length);
  scratch[length] = '\0';
  output->type = JsonNumber;
  output->number = strtod(scratch, NULL);
  return 1;
}

/** Looks up an object member by key, or NULL when absent. */
static JsonValue *ObjectMember(JsonValue *object, const char *key) {
  if (!object || object->type != JsonObject) return NULL;
  for (size_t index = 0; index < object->memberCount; index++) {
    if (strcmp(object->members[index].key, key) == 0) return object->members[index].value;
  }
  return NULL;
}

/** Compares a decoded slice with a NUL-terminated literal. */
static int SliceEquals(Slice slice, const char *literal) {
  size_t length = strlen(literal);
  return slice.length == length && memcmp(slice.pointer, literal, length) == 0;
}

// ---------------------------------------------------------------------------
// Minimal base64
// ---------------------------------------------------------------------------

/** Decodes standard base64 within the text byte budget. */
static int DecodeBase64(Slice encoded, unsigned char **content, size_t *contentLength, const char **errorCode) {
  size_t maximumEncoded = (size_t)(((kMaxTextBytes + 2) / 3) * 4 + 8);
  if (encoded.length > maximumEncoded) {
    *errorCode = kFileTooLarge;
    return 0;
  }
  if (encoded.length % 4 != 0) {
    *errorCode = kInvalidText;
    return 0;
  }
  size_t padding = 0;
  if (encoded.length >= 1 && encoded.pointer[encoded.length - 1] == '=') padding++;
  if (encoded.length >= 2 && encoded.pointer[encoded.length - 2] == '=') padding++;
  size_t capacity = (encoded.length / 4) * 3;
  if (capacity < padding) {
    *errorCode = kInvalidText;
    return 0;
  }
  capacity -= padding;
  if (capacity > kMaxTextBytes) {
    *errorCode = kFileTooLarge;
    return 0;
  }
  unsigned char *bytes = malloc(capacity ? capacity : 1);
  if (!bytes) {
    *errorCode = kHelperFailed;
    return 0;
  }
  size_t written = 0;
  for (size_t index = 0; index < encoded.length; index += 4) {
    int values[4];
    for (int slot = 0; slot < 4; slot++) {
      unsigned char value = (unsigned char)encoded.pointer[index + slot];
      if (value == '=') {
        if (index + 4 != encoded.length || slot < 2) {
          free(bytes);
          *errorCode = kInvalidText;
          return 0;
        }
        values[slot] = -1;
        continue;
      }
      if (value >= 'A' && value <= 'Z') values[slot] = value - 'A';
      else if (value >= 'a' && value <= 'z') values[slot] = value - 'a' + 26;
      else if (value >= '0' && value <= '9') values[slot] = value - '0' + 52;
      else if (value == '+') values[slot] = 62;
      else if (value == '/') values[slot] = 63;
      else {
        free(bytes);
        *errorCode = kInvalidText;
        return 0;
      }
    }
    if (written < capacity && values[0] >= 0 && values[1] >= 0) {
      bytes[written++] = (unsigned char)((values[0] << 2) | (values[1] >> 4));
    }
    if (written < capacity && values[2] >= 0) {
      bytes[written++] = (unsigned char)(((values[1] & 0xF) << 4) | (values[2] >> 2));
    }
    if (written < capacity && values[3] >= 0) {
      bytes[written++] = (unsigned char)(((values[2] & 0x3) << 6) | values[3]);
    }
  }
  if (written != capacity) {
    free(bytes);
    *errorCode = kInvalidText;
    return 0;
  }
  *content = bytes;
  *contentLength = capacity;
  return 1;
}

/** Appends the standard base64 encoding of a byte range. */
static int EncodeBase64(Buffer *buffer, const unsigned char *bytes, size_t length) {
  static const char *const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t chunks = (length + 2) / 3;
  if (!BufferReserve(buffer, chunks * 4 + 4)) return 0;
  size_t index = 0;
  while (index + 3 <= length) {
    uint32_t chunk = ((uint32_t)bytes[index] << 16) | ((uint32_t)bytes[index + 1] << 8) | bytes[index + 2];
    char out[4] = {
      alphabet[(chunk >> 18) & 0x3F],
      alphabet[(chunk >> 12) & 0x3F],
      alphabet[(chunk >> 6) & 0x3F],
      alphabet[chunk & 0x3F],
    };
    if (!BufferAppend(buffer, out, 4)) return 0;
    index += 3;
  }
  if (index < length) {
    uint32_t chunk = (uint32_t)bytes[index] << 16;
    int remaining = (int)(length - index);
    if (remaining == 2) chunk |= (uint32_t)bytes[index + 1] << 8;
    char out[4] = {
      alphabet[(chunk >> 18) & 0x3F],
      alphabet[(chunk >> 12) & 0x3F],
      remaining == 2 ? alphabet[(chunk >> 6) & 0x3F] : '=',
      '=',
    };
    if (!BufferAppend(buffer, out, 4)) return 0;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Path capability validation
// ---------------------------------------------------------------------------

/** Reads one stdin line within `limit` bytes and strips its terminator. */
static int ReadLine(size_t limit, const char **errorCode, Slice *output) {
  char *line = NULL;
  size_t capacity = 0;
  ssize_t length = getline(&line, &capacity, stdin);
  if (length < 0) {
    free(line);
    *errorCode = kInvalidPath;
    return 0;
  }
  if ((size_t)length > limit) {
    free(line);
    *errorCode = kRequestTooLarge;
    return 0;
  }
  while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) length--;
  output->pointer = line;
  output->length = (size_t)length;
  output->owned = line;
  return 1;
}

/** Parses a canonical unsigned decimal string without overflow. */
static int ParseUnsignedDecimal(Slice value, uint64_t maximum, uint64_t *output) {
  if (value.length == 0 || value.length > 20) return 0;
  if (value.length > 1 && value.pointer[0] == '0') return 0;
  uint64_t parsed = 0;
  for (size_t index = 0; index < value.length; index++) {
    char character = value.pointer[index];
    if (character < '0' || character > '9') return 0;
    uint64_t digit = (uint64_t)(character - '0');
    if (parsed > (maximum - digit) / 10) return 0;
    parsed = parsed * 10 + digit;
  }
  *output = parsed;
  return 1;
}

/** Matches Windows device names the capability format refuses on every platform. */
static int IsWindowsReservedName(const char *segment) {
  size_t length = strcspn(segment, ".");
  char bare[16];
  if (length >= sizeof(bare)) return 0;
  for (size_t index = 0; index < length; index++) {
    char character = segment[index];
    bare[index] = (character >= 'A' && character <= 'Z') ? (char)(character - 'A' + 'a') : character;
  }
  bare[length] = '\0';
  if (strcmp(bare, "con") == 0 || strcmp(bare, "prn") == 0
    || strcmp(bare, "aux") == 0 || strcmp(bare, "nul") == 0) return 1;
  if (length == 4 && (strncmp(bare, "com", 3) == 0 || strncmp(bare, "lpt", 3) == 0)
    && bare[3] >= '1' && bare[3] <= '9') return 1;
  return 0;
}

/** Rejects empty, dot, colon, trailing-dot/space, and reserved-name segments. */
static int IsSafeSegment(const char *segment, size_t length) {
  if (length == 0) return 0;
  if ((length == 1 && segment[0] == '.') || (length == 2 && segment[0] == '.' && segment[1] == '.')) return 0;
  if (memchr(segment, '\0', length)) return 0;
  if (memchr(segment, ':', length)) return 0;
  if (segment[length - 1] == '.' || segment[length - 1] == ' ') return 0;
  char *copy = malloc(length + 1);
  if (!copy) return 0;
  memcpy(copy, segment, length);
  copy[length] = '\0';
  int reserved = IsWindowsReservedName(copy);
  free(copy);
  return !reserved;
}

typedef struct {
  char **names;
  size_t count;
} SegmentList;

/** Releases a parsed segment list. */
static void FreeSegments(SegmentList *segments) {
  if (!segments->names) return;
  for (size_t index = 0; index < segments->count; index++) free(segments->names[index]);
  free(segments->names);
  segments->names = NULL;
  segments->count = 0;
}

/** Splits on both separators; an empty relative path addresses the root itself. */
static int SegmentsForRelativePath(Slice relativePath, SegmentList *output, const char **errorCode) {
  output->names = NULL;
  output->count = 0;
  // An empty relative path is legal: it addresses the capability root itself.
  if (relativePath.length > kMaxPathCharacters || memchr(relativePath.pointer, '\0', relativePath.length)) {
    *errorCode = kInvalidPath;
    return 0;
  }
  if (relativePath.length == 0) return 1;
  if (relativePath.pointer[0] == '/' || relativePath.pointer[0] == '\\') {
    *errorCode = kInvalidPath;
    return 0;
  }
  size_t start = 0;
  for (size_t index = 0; index <= relativePath.length; index++) {
    int atEnd = index == relativePath.length;
    char value = atEnd ? '/' : relativePath.pointer[index];
    if (!atEnd && value != '/' && value != '\\') continue;
    size_t segmentLength = index - start;
    if (segmentLength > 0 && !(segmentLength == 1 && relativePath.pointer[start] == '.')) {
      if (!IsSafeSegment(relativePath.pointer + start, segmentLength)) {
        FreeSegments(output);
        *errorCode = kInvalidPath;
        return 0;
      }
      if (output->count >= kMaxSegments) {
        FreeSegments(output);
        *errorCode = kInvalidPath;
        return 0;
      }
      char **grown = realloc(output->names, (output->count + 1) * sizeof(char *));
      if (!grown) {
        FreeSegments(output);
        *errorCode = kHelperFailed;
        return 0;
      }
      output->names = grown;
      char *name = malloc(segmentLength + 1);
      if (!name) {
        FreeSegments(output);
        *errorCode = kHelperFailed;
        return 0;
      }
      memcpy(name, relativePath.pointer + start, segmentLength);
      name[segmentLength] = '\0';
      output->names[output->count++] = name;
    }
    start = index + 1;
  }
  return 1;
}

static const char *CodeForErrno(int value) {
  if (value == ELOOP) return kReparsePoint;
  if (value == ENOENT || value == ENOTDIR) return kNotFound;
  return kOpenFailed;
}

/** Reports whether a name resolves to a symlink, without following it. */
static int HasSymlinkAt(int parent, const char *name) {
  struct stat information;
  if (fstatat(parent, name, &information, AT_SYMLINK_NOFOLLOW) != 0) return 0;
  return S_ISLNK(information.st_mode) ? 1 : 0;
}

/** Opens the capability root with O_NOFOLLOW and verifies its recorded device identity. */
static int OpenRoot(Slice rootPath, uint64_t expectedDevice, uint64_t expectedFileIndex, const char **errorCode) {
  if (rootPath.length == 0 || rootPath.length > kMaxPathCharacters
    || memchr(rootPath.pointer, '\0', rootPath.length) || rootPath.pointer[0] != '/') {
    *errorCode = kInvalidPath;
    return -1;
  }
  char *path = malloc(rootPath.length + 1);
  if (!path) {
    *errorCode = kHelperFailed;
    return -1;
  }
  memcpy(path, rootPath.pointer, rootPath.length);
  path[rootPath.length] = '\0';
  int descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  free(path);
  if (descriptor < 0) {
    *errorCode = CodeForErrno(errno);
    return -1;
  }
  struct stat information;
  if (fstat(descriptor, &information) < 0) {
    const char *code = CodeForErrno(errno);
    close(descriptor);
    *errorCode = code;
    return -1;
  }
  if ((uint64_t)information.st_dev != expectedDevice || (uint64_t)information.st_ino != expectedFileIndex) {
    close(descriptor);
    *errorCode = kRootChanged;
    return -1;
  }
  return descriptor;
}

/** Opens one child directory, optionally creating it, without following symlinks. */
static int OpenDirectoryAt(int parent, const char *name, int createIfMissing, const char **errorCode) {
  if (HasSymlinkAt(parent, name)) {
    *errorCode = kReparsePoint;
    return -1;
  }
  int descriptor = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor >= 0 || !createIfMissing || errno != ENOENT) {
    if (descriptor < 0) *errorCode = CodeForErrno(errno);
    return descriptor;
  }
  if (mkdirat(parent, name, 0755) < 0 && errno != EEXIST) {
    *errorCode = CodeForErrno(errno);
    return -1;
  }
  descriptor = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) *errorCode = CodeForErrno(errno);
  return descriptor;
}

/** Walks the whole segment chain starting from a verified root descriptor. */
static int OpenDirectoryChain(
  Slice rootPath,
  uint64_t expectedDevice,
  uint64_t expectedFileIndex,
  const SegmentList *segments,
  int createIfMissing,
  const char **errorCode
) {
  int current = OpenRoot(rootPath, expectedDevice, expectedFileIndex, errorCode);
  if (current < 0) return -1;
  for (size_t index = 0; index < segments->count; index++) {
    int child = OpenDirectoryAt(current, segments->names[index], createIfMissing, errorCode);
    close(current);
    if (child < 0) return -1;
    current = child;
  }
  return current;
}

/** Opens the parent of the final segment and hands back that leaf name. */
static int OpenParentDirectory(
  Slice rootPath,
  uint64_t expectedDevice,
  uint64_t expectedFileIndex,
  const SegmentList *segments,
  const char **leaf,
  const char **errorCode
) {
  if (segments->count == 0) {
    *errorCode = kInvalidPath;
    return -1;
  }
  *leaf = segments->names[segments->count - 1];
  SegmentList prefix = { segments->names, segments->count - 1 };
  return OpenDirectoryChain(rootPath, expectedDevice, expectedFileIndex, &prefix, 0, errorCode);
}

/** Refuses anything that is not a regular file. */
static int RequireRegularFile(int descriptor, const char **errorCode) {
  struct stat information;
  if (fstat(descriptor, &information) < 0) {
    *errorCode = CodeForErrno(errno);
    return 0;
  }
  if (!S_ISREG(information.st_mode)) {
    *errorCode = kOpenFailed;
    return 0;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Reads a capability file and returns its bytes as base64. */
static void ReadText(
  Slice rootPath,
  uint64_t expectedDevice,
  uint64_t expectedFileIndex,
  const SegmentList *segments,
  uint64_t maxBytes
) {
  const char *errorCode = NULL;
  const char *leaf = NULL;
  int parent = OpenParentDirectory(rootPath, expectedDevice, expectedFileIndex, segments, &leaf, &errorCode);
  if (parent < 0) {
    WriteFailure(errorCode);
    return;
  }
  int file = openat(parent, leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (file < 0) {
    const char *code = CodeForErrno(errno);
    close(parent);
    WriteFailure(code);
    return;
  }
  if (!RequireRegularFile(file, &errorCode)) {
    close(file);
    close(parent);
    WriteFailure(errorCode);
    return;
  }
  struct stat information;
  if (fstat(file, &information) < 0) {
    const char *code = CodeForErrno(errno);
    close(file);
    close(parent);
    WriteFailure(code);
    return;
  }
  if (information.st_size < 0 || (uint64_t)information.st_size > maxBytes) {
    close(file);
    close(parent);
    WriteFailure(kFileTooLarge);
    return;
  }
  Buffer content = { NULL, 0, 0 };
  unsigned char chunk[8192];
  for (;;) {
    ssize_t count = read(file, chunk, sizeof(chunk));
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      free(content.bytes);
      close(file);
      close(parent);
      WriteFailure(kOpenFailed);
      return;
    }
    if (content.length > maxBytes || (uint64_t)count > maxBytes - content.length) {
      free(content.bytes);
      close(file);
      close(parent);
      WriteFailure(kFileTooLarge);
      return;
    }
    if (!BufferAppend(&content, (const char *)chunk, (size_t)count)) {
      free(content.bytes);
      close(file);
      close(parent);
      WriteFailure(kHelperFailed);
      return;
    }
  }
  close(file);
  close(parent);

  Buffer response = { NULL, 0, 0 };
  BufferAppendLiteral(&response, "{\"ok\":true,\"contentBase64\":\"");
  if (!EncodeBase64(&response, (const unsigned char *)content.bytes, content.length)) {
    free(content.bytes);
    free(response.bytes);
    WriteFailure(kHelperFailed);
    return;
  }
  BufferAppendLiteral(&response, "\"}");
  free(content.bytes);
  WriteResponse(&response);
  free(response.bytes);
}

/** Answers existence for a capability without following symlinks. */
static void Exists(
  Slice rootPath,
  uint64_t expectedDevice,
  uint64_t expectedFileIndex,
  const SegmentList *segments
) {
  const char *errorCode = NULL;
  if (segments->count == 0) {
    int root = OpenRoot(rootPath, expectedDevice, expectedFileIndex, &errorCode);
    if (root < 0) {
      WriteFailure(errorCode);
      return;
    }
    close(root);
    WriteExists(1);
    return;
  }
  const char *leaf = NULL;
  int parent = OpenParentDirectory(rootPath, expectedDevice, expectedFileIndex, segments, &leaf, &errorCode);
  if (parent < 0) {
    if (errorCode && strcmp(errorCode, kNotFound) == 0) {
      WriteExists(0);
      return;
    }
    WriteFailure(errorCode);
    return;
  }
  struct stat information;
  int result = fstatat(parent, leaf, &information, AT_SYMLINK_NOFOLLOW);
  int savedErrno = errno;
  close(parent);
  if (result < 0) {
    if (savedErrno == ENOENT || savedErrno == ENOTDIR) {
      WriteExists(0);
      return;
    }
    WriteFailure(CodeForErrno(savedErrno));
    return;
  }
  if (S_ISLNK(information.st_mode)) {
    WriteFailure(kReparsePoint);
    return;
  }
  WriteExists(1);
}

/** Creates every missing directory in the capability path. */
static void MakeDirectory(
  Slice rootPath,
  uint64_t expectedDevice,
  uint64_t expectedFileIndex,
  const SegmentList *segments
) {
  const char *errorCode = NULL;
  int directory = OpenDirectoryChain(rootPath, expectedDevice, expectedFileIndex, segments, 1, &errorCode);
  if (directory < 0) {
    WriteFailure(errorCode);
    return;
  }
  close(directory);
  WriteSuccess();
}

/** Lists a capability directory, refusing symlinked entries. */
static void ListDirectory(
  Slice rootPath,
  uint64_t expectedDevice,
  uint64_t expectedFileIndex,
  const SegmentList *segments
) {
  const char *errorCode = NULL;
  int directory = OpenDirectoryChain(rootPath, expectedDevice, expectedFileIndex, segments, 0, &errorCode);
  if (directory < 0) {
    WriteFailure(errorCode);
    return;
  }
  int duplicate = dup(directory);
  if (duplicate < 0) {
    close(directory);
    WriteFailure(kOpenFailed);
    return;
  }
  DIR *stream = fdopendir(duplicate);
  if (!stream) {
    close(duplicate);
    close(directory);
    WriteFailure(kOpenFailed);
    return;
  }
  Buffer response = { NULL, 0, 0 };
  BufferAppendLiteral(&response, "{\"ok\":true,\"entries\":[");
  size_t count = 0;
  const char *failure = NULL;
  struct dirent *entry = NULL;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    size_t nameLength = strlen(entry->d_name);
    if (!IsSafeSegment(entry->d_name, nameLength)) {
      failure = kOpenFailed;
      break;
    }
    struct stat information;
    if (fstatat(directory, entry->d_name, &information, AT_SYMLINK_NOFOLLOW) < 0) {
      failure = CodeForErrno(errno);
      break;
    }
    if (S_ISLNK(information.st_mode)) {
      failure = kReparsePoint;
      break;
    }
    if (count > 0 && !BufferAppendLiteral(&response, ",")) {
      failure = kHelperFailed;
      break;
    }
    if (!BufferAppendLiteral(&response, "{\"name\":")
      || !BufferAppendJsonString(&response, entry->d_name, nameLength)
      || !BufferAppendLiteral(&response, ",\"isDirectory\":")
      || !BufferAppendLiteral(&response, S_ISDIR(information.st_mode) ? "true" : "false")
      || !BufferAppendLiteral(&response, "}")) {
      failure = kHelperFailed;
      break;
    }
    count++;
    if (count > kMaxDirectoryEntries) {
      failure = kDirectoryTooLarge;
      break;
    }
  }
  closedir(stream);
  close(directory);
  if (failure) {
    free(response.bytes);
    WriteFailure(failure);
    return;
  }
  BufferAppendLiteral(&response, "]}");
  WriteResponse(&response);
  free(response.bytes);
}

/** Creates an exclusive temporary file beside the target for atomic replace. */
static int OpenTemporaryFile(int parent, char **temporaryName, const char **errorCode) {
  unsigned int random = 0;
  if (getrandom(&random, sizeof(random), 0) != (ssize_t)sizeof(random)) random = 0;
  for (int attempt = 0; attempt < 32; attempt++) {
    char candidate[96];
    snprintf(candidate, sizeof(candidate), ".ai-novel-%d-%08x-%02x.tmp", (int)getpid(), random, attempt);
    int descriptor = openat(
      parent,
      candidate,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      0600
    );
    if (descriptor >= 0) {
      char *copy = malloc(strlen(candidate) + 1);
      if (!copy) {
        close(descriptor);
        unlinkat(parent, candidate, 0);
        *errorCode = kHelperFailed;
        return -1;
      }
      strcpy(copy, candidate);
      *temporaryName = copy;
      return descriptor;
    }
    if (errno != EEXIST) {
      *errorCode = kWriteFailed;
      return -1;
    }
  }
  *errorCode = kWriteFailed;
  return -1;
}

/** Writes and fsyncs the full content of an atomic write. */
static int WriteAll(int descriptor, const unsigned char *content, size_t length, const char **errorCode) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(descriptor, content + offset, length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      *errorCode = kWriteFailed;
      return 0;
    }
    offset += (size_t)count;
  }
  if (fsync(descriptor) < 0) {
    *errorCode = kWriteFailed;
    return 0;
  }
  return 1;
}

/** Performs the ready/commit two-phase atomic replace. */
static void WriteAtomically(
  JsonValue *request,
  Slice rootPath,
  uint64_t expectedDevice,
  uint64_t expectedFileIndex,
  const SegmentList *segments
) {
  JsonValue *encoded = ObjectMember(request, "contentBase64");
  if (!encoded || encoded->type != JsonString) {
    WriteFailure(kInvalidText);
    return;
  }
  JsonValue *required = ObjectMember(request, "mustAlreadyExist");
  if (required && required->type != JsonBoolean) {
    WriteFailure(kInvalidOperation);
    return;
  }
  int mustAlreadyExist = required ? required->boolean : 0;

  const char *errorCode = NULL;
  unsigned char *content = NULL;
  size_t contentLength = 0;
  if (!DecodeBase64(encoded->string, &content, &contentLength, &errorCode)) {
    WriteFailure(errorCode);
    return;
  }

  const char *leaf = NULL;
  int parent = OpenParentDirectory(rootPath, expectedDevice, expectedFileIndex, segments, &leaf, &errorCode);
  if (parent < 0) {
    free(content);
    WriteFailure(errorCode);
    return;
  }

  int existing = -1;
  struct stat expected;
  memset(&expected, 0, sizeof(expected));
  if (mustAlreadyExist) {
    existing = openat(parent, leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (existing < 0) {
      const char *code = CodeForErrno(errno);
      free(content);
      close(parent);
      WriteFailure(code);
      return;
    }
    if (!RequireRegularFile(existing, &errorCode) || fstat(existing, &expected) < 0) {
      free(content);
      if (existing >= 0) close(existing);
      close(parent);
      WriteFailure(errorCode ? errorCode : kWriteFailed);
      return;
    }
  }

  char *temporaryName = NULL;
  int temporary = OpenTemporaryFile(parent, &temporaryName, &errorCode);
  if (temporary < 0 || !WriteAll(temporary, content, contentLength, &errorCode)) {
    if (temporary >= 0) close(temporary);
    if (temporaryName) {
      unlinkat(parent, temporaryName, 0);
      free(temporaryName);
    }
    if (existing >= 0) close(existing);
    free(content);
    close(parent);
    WriteFailure(errorCode);
    return;
  }
  close(temporary);
  free(content);

  // The descriptors stay open while the main process revalidates the project
  // lease, mirroring the ready/commit boundary of the other platform helpers.
  WriteReady();

  Slice commandLine = { NULL, 0, NULL };
  if (!ReadLine(kMaxCommandBytes, &errorCode, &commandLine)) {
    unlinkat(parent, temporaryName, 0);
    free(temporaryName);
    if (existing >= 0) close(existing);
    close(parent);
    WriteFailure(errorCode);
    return;
  }
  JsonValue command = { 0 };
  Parser parser = { commandLine.pointer, commandLine.pointer + commandLine.length, NULL };
  int committed = 0;
  if (ParseJsonValue(&parser, &command) && command.type == JsonObject) {
    JsonValue *verb = ObjectMember(&command, "command");
    committed = verb && verb->type == JsonString && SliceEquals(verb->string, "commit");
  }
  free(commandLine.owned);
  if (!committed) {
    unlinkat(parent, temporaryName, 0);
    free(temporaryName);
    if (existing >= 0) close(existing);
    close(parent);
    WriteFailure(kCancelled);
    return;
  }

  if (mustAlreadyExist) {
    struct stat actual;
    int check = fstatat(parent, leaf, &actual, AT_SYMLINK_NOFOLLOW);
    if (check < 0 || S_ISLNK(actual.st_mode)
      || actual.st_dev != expected.st_dev || actual.st_ino != expected.st_ino) {
      unlinkat(parent, temporaryName, 0);
      free(temporaryName);
      close(existing);
      close(parent);
      WriteFailure(kWriteFailed);
      return;
    }
  }

  if (renameat(parent, temporaryName, parent, leaf) < 0) {
    unlinkat(parent, temporaryName, 0);
    free(temporaryName);
    if (existing >= 0) close(existing);
    close(parent);
    WriteFailure(kWriteFailed);
    return;
  }
  free(temporaryName);
  // The rename is only durable once the parent directory entry is on disk.
  if (fsync(parent) < 0) {
    if (existing >= 0) close(existing);
    close(parent);
    WriteFailure(kWriteFailed);
    return;
  }
  if (existing >= 0) close(existing);
  close(parent);
  WriteSuccess();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Reads one request, dispatches it, and always exits 0 after writing a response. */
int main(void) {
  const char *errorCode = NULL;
  Slice line = { NULL, 0, NULL };
  if (!ReadLine(kMaxRequestBytes, &errorCode, &line)) {
    WriteFailure(errorCode);
    return 0;
  }
  Parser parser = { line.pointer, line.pointer + line.length, NULL };
  JsonValue request = { 0 };
  if (!ParseJsonValue(&parser, &request) || request.type != JsonObject) {
    free(line.owned);
    WriteFailure(kInvalidPath);
    return 0;
  }

  JsonValue *operation = ObjectMember(&request, "operation");
  JsonValue *rootPath = ObjectMember(&request, "rootPath");
  JsonValue *relativePath = ObjectMember(&request, "relativePath");
  JsonValue *identity = ObjectMember(&request, "rootIdentity");
  if (!operation || operation->type != JsonString
    || !rootPath || rootPath->type != JsonString
    || !relativePath || relativePath->type != JsonString
    || !identity || identity->type != JsonObject) {
    free(line.owned);
    WriteFailure(kInvalidPath);
    return 0;
  }

  uint64_t expectedDevice = 0;
  uint64_t expectedFileIndex = 0;
  JsonValue *device = ObjectMember(identity, "volumeSerialNumber");
  JsonValue *fileIndex = ObjectMember(identity, "fileIndex");
  if (identity->memberCount != 2
    || !device || device->type != JsonString
    || !fileIndex || fileIndex->type != JsonString
    || !ParseUnsignedDecimal(device->string, UINT64_MAX, &expectedDevice)
    || !ParseUnsignedDecimal(fileIndex->string, UINT64_MAX, &expectedFileIndex)) {
    free(line.owned);
    WriteFailure(kInvalidPath);
    return 0;
  }

  SegmentList segments = { NULL, 0 };
  if (!SegmentsForRelativePath(relativePath->string, &segments, &errorCode)) {
    free(line.owned);
    WriteFailure(errorCode);
    return 0;
  }

  if (SliceEquals(operation->string, "read")) {
    JsonValue *maxBytes = ObjectMember(&request, "maxBytes");
    if (!maxBytes || maxBytes->type != JsonNumber
      || !isfinite(maxBytes->number) || maxBytes->number < 0
      || maxBytes->number > (double)kMaxTextBytes
      || (double)(uint64_t)maxBytes->number != maxBytes->number) {
      WriteFailure(kInvalidOperation);
    } else {
      ReadText(rootPath->string, expectedDevice, expectedFileIndex, &segments, (uint64_t)maxBytes->number);
    }
  } else if (SliceEquals(operation->string, "write")) {
    WriteAtomically(&request, rootPath->string, expectedDevice, expectedFileIndex, &segments);
  } else if (SliceEquals(operation->string, "mkdir")) {
    MakeDirectory(rootPath->string, expectedDevice, expectedFileIndex, &segments);
  } else if (SliceEquals(operation->string, "exists")) {
    Exists(rootPath->string, expectedDevice, expectedFileIndex, &segments);
  } else if (SliceEquals(operation->string, "list")) {
    ListDirectory(rootPath->string, expectedDevice, expectedFileIndex, &segments);
  } else {
    WriteFailure(kInvalidOperation);
  }

  FreeSegments(&segments);
  free(line.owned);
  return 0;
}
