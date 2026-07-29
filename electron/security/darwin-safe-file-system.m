// This helper is deliberately native instead of a Node fs fallback. Every path
// component is opened from a trusted directory descriptor with openat(2) and
// O_NOFOLLOW, so a symlink replacement cannot redirect a later operation out
// of the capability root.
#import <Foundation/Foundation.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static const NSUInteger kMaxPathCharacters = 32000;
static const NSUInteger kMaxSegments = 256;
static const NSUInteger kMaxTextBytes = 64 * 1024 * 1024;
static const NSUInteger kMaxDirectoryEntries = 16384;
static const NSUInteger kMaxRequestBytes = 100 * 1024 * 1024;

static NSString *const kInvalidPath = @"SECURE_FS_INVALID_PATH";
static NSString *const kNotFound = @"SECURE_FS_NOT_FOUND";
static NSString *const kReparsePoint = @"SECURE_FS_REPARSE_POINT";
static NSString *const kOpenFailed = @"SECURE_FS_OPEN_FAILED";
static NSString *const kWriteFailed = @"SECURE_FS_WRITE_FAILED";

static void WriteResponse(NSDictionary *response) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:&error];
  if (!data) {
    static const char fallback[] = "{\"ok\":false,\"code\":\"SECURE_FS_HELPER_FAILED\"}\n";
    fwrite(fallback, 1, sizeof(fallback) - 1, stdout);
    fflush(stdout);
    return;
  }
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static NSDictionary *Failure(NSString *code) {
  return @{ @"ok": @NO, @"code": code ?: @"SECURE_FS_HELPER_FAILED" };
}

static NSDictionary *Success(void) {
  return @{ @"ok": @YES };
}

static NSString *CodeForErrno(int value) {
  if (value == ELOOP) return kReparsePoint;
  if (value == ENOENT || value == ENOTDIR) return kNotFound;
  return kOpenFailed;
}

static NSData *ReadLine(NSUInteger limit, NSString **errorCode) {
  char *line = NULL;
  size_t capacity = 0;
  ssize_t length = getline(&line, &capacity, stdin);
  if (length < 0) {
    free(line);
    *errorCode = @"SECURE_FS_INVALID_PATH";
    return nil;
  }
  if ((NSUInteger)length > limit) {
    free(line);
    *errorCode = @"SECURE_FS_REQUEST_TOO_LARGE";
    return nil;
  }
  while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) length--;
  return [NSData dataWithBytesNoCopy:line length:(NSUInteger)length freeWhenDone:YES];
}

static NSDictionary *ReadRequest(NSUInteger limit, NSString **errorCode) {
  NSData *line = ReadLine(limit, errorCode);
  if (!line) return nil;
  NSError *jsonError = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:line options:0 error:&jsonError];
  if (![parsed isKindOfClass:[NSDictionary class]]) {
    *errorCode = kInvalidPath;
    return nil;
  }
  return (NSDictionary *)parsed;
}

static BOOL IsJsonBoolean(id value) {
  return value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL GetString(NSDictionary *request, NSString *key, NSString **output, NSString **errorCode) {
  id value = request[key];
  if (![value isKindOfClass:[NSString class]]) {
    *errorCode = kInvalidPath;
    return NO;
  }
  *output = (NSString *)value;
  return YES;
}

static BOOL IsWindowsReservedName(NSString *segment) {
  NSString *bare = [[segment componentsSeparatedByString:@"."] firstObject].lowercaseString;
  if ([bare isEqualToString:@"con"] || [bare isEqualToString:@"prn"]
      || [bare isEqualToString:@"aux"] || [bare isEqualToString:@"nul"]) return YES;
  if (bare.length == 4) {
    unichar suffix = [bare characterAtIndex:3];
    NSString *prefix = [bare substringToIndex:3];
    if (([prefix isEqualToString:@"com"] || [prefix isEqualToString:@"lpt"])
        && suffix >= '1' && suffix <= '9') return YES;
  }
  return NO;
}

static BOOL IsSafeSegment(NSString *segment) {
  if (segment.length == 0 || [segment isEqualToString:@"."] || [segment isEqualToString:@".."]
      || [segment rangeOfString:@"\0"].location != NSNotFound
      || [segment rangeOfString:@":"].location != NSNotFound
      || [segment hasSuffix:@"."] || [segment hasSuffix:@" "]
      || IsWindowsReservedName(segment)) return NO;
  return YES;
}

static NSArray<NSString *> *SegmentsForRelativePath(NSString *relativePath, NSString **errorCode) {
  if (relativePath.length > kMaxPathCharacters
      || [relativePath rangeOfString:@"\0"].location != NSNotFound
      || [relativePath hasPrefix:@"/"] || [relativePath hasPrefix:@"\\"]) {
    *errorCode = kInvalidPath;
    return nil;
  }
  NSArray<NSString *> *raw = [relativePath componentsSeparatedByCharactersInSet:
    [NSCharacterSet characterSetWithCharactersInString:@"/\\"]];
  NSMutableArray<NSString *> *segments = [NSMutableArray arrayWithCapacity:raw.count];
  for (NSString *segment in raw) {
    if (segment.length == 0 || [segment isEqualToString:@"."]) continue;
    if (!IsSafeSegment(segment)) {
      *errorCode = kInvalidPath;
      return nil;
    }
    [segments addObject:segment];
    if (segments.count > kMaxSegments) {
      *errorCode = kInvalidPath;
      return nil;
    }
  }
  return segments;
}

static int OpenRoot(NSString *rootPath, NSString **errorCode) {
  if (rootPath.length == 0 || rootPath.length > kMaxPathCharacters
      || [rootPath rangeOfString:@"\0"].location != NSNotFound || ![rootPath hasPrefix:@"/"]) {
    *errorCode = kInvalidPath;
    return -1;
  }
  const char *path = rootPath.fileSystemRepresentation;
  if (!path) {
    *errorCode = kInvalidPath;
    return -1;
  }
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) *errorCode = CodeForErrno(errno);
  return fd;
}

static int OpenDirectoryAt(int parent, NSString *segment, BOOL createIfMissing, NSString **errorCode) {
  const char *name = segment.fileSystemRepresentation;
  if (!name) {
    *errorCode = kInvalidPath;
    return -1;
  }
  struct stat existing;
  if (fstatat(parent, name, &existing, AT_SYMLINK_NOFOLLOW) == 0) {
    if (S_ISLNK(existing.st_mode)) {
      *errorCode = kReparsePoint;
      return -1;
    }
  } else if (errno != ENOENT) {
    *errorCode = CodeForErrno(errno);
    return -1;
  }
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd >= 0 || !createIfMissing || errno != ENOENT) {
    if (fd < 0) *errorCode = CodeForErrno(errno);
    return fd;
  }
  if (mkdirat(parent, name, 0755) < 0 && errno != EEXIST) {
    *errorCode = CodeForErrno(errno);
    return -1;
  }
  fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) *errorCode = CodeForErrno(errno);
  return fd;
}

static int OpenDirectoryChain(NSString *rootPath, NSArray<NSString *> *segments, BOOL createIfMissing, NSString **errorCode) {
  int current = OpenRoot(rootPath, errorCode);
  if (current < 0) return -1;
  for (NSString *segment in segments) {
    int child = OpenDirectoryAt(current, segment, createIfMissing, errorCode);
    close(current);
    if (child < 0) return -1;
    current = child;
  }
  return current;
}

static int OpenParentDirectory(
  NSString *rootPath,
  NSArray<NSString *> *segments,
  NSString **leaf,
  NSString **errorCode
) {
  if (segments.count == 0) {
    *errorCode = kInvalidPath;
    return -1;
  }
  *leaf = segments.lastObject;
  NSArray<NSString *> *prefix = [segments subarrayWithRange:NSMakeRange(0, segments.count - 1)];
  return OpenDirectoryChain(rootPath, prefix, NO, errorCode);
}

static BOOL RequireRegularFile(int fd, NSString **errorCode) {
  struct stat information;
  if (fstat(fd, &information) < 0) {
    *errorCode = CodeForErrno(errno);
    return NO;
  }
  if (!S_ISREG(information.st_mode)) {
    *errorCode = kOpenFailed;
    return NO;
  }
  return YES;
}

static BOOL ReadAll(int fd, NSMutableData **output, NSString **errorCode) {
  NSMutableData *data = [NSMutableData data];
  unsigned char buffer[8192];
  for (;;) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      *errorCode = kOpenFailed;
      return NO;
    }
    if (data.length + (NSUInteger)count > kMaxTextBytes) {
      *errorCode = @"SECURE_FS_FILE_TOO_LARGE";
      return NO;
    }
    [data appendBytes:buffer length:(NSUInteger)count];
  }
  *output = data;
  return YES;
}

static BOOL WriteAll(int fd, NSData *content, NSString **errorCode) {
  const unsigned char *bytes = content.bytes;
  NSUInteger offset = 0;
  while (offset < content.length) {
    ssize_t count = write(fd, bytes + offset, content.length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      *errorCode = kWriteFailed;
      return NO;
    }
    offset += (NSUInteger)count;
  }
  if (fsync(fd) < 0) {
    *errorCode = kWriteFailed;
    return NO;
  }
  return YES;
}

static NSDictionary *ReadText(NSString *rootPath, NSArray<NSString *> *segments) {
  NSString *errorCode = nil;
  NSString *leaf = nil;
  int parent = OpenParentDirectory(rootPath, segments, &leaf, &errorCode);
  if (parent < 0) return Failure(errorCode);
  const char *name = leaf.fileSystemRepresentation;
  int file = name ? openat(parent, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC) : -1;
  if (file < 0) {
    NSString *code = name ? CodeForErrno(errno) : kInvalidPath;
    close(parent);
    return Failure(code);
  }
  if (!RequireRegularFile(file, &errorCode)) {
    close(file);
    close(parent);
    return Failure(errorCode);
  }
  NSMutableData *content = nil;
  BOOL ok = ReadAll(file, &content, &errorCode);
  close(file);
  close(parent);
  if (!ok) return Failure(errorCode);
  return @{ @"ok": @YES, @"contentBase64": [content base64EncodedStringWithOptions:0] };
}

static NSDictionary *Exists(NSString *rootPath, NSArray<NSString *> *segments) {
  NSString *errorCode = nil;
  if (segments.count == 0) {
    int root = OpenRoot(rootPath, &errorCode);
    if (root < 0) return Failure(errorCode);
    close(root);
    return @{ @"ok": @YES, @"exists": @YES };
  }
  NSString *leaf = nil;
  int parent = OpenParentDirectory(rootPath, segments, &leaf, &errorCode);
  if (parent < 0) {
    if ([errorCode isEqualToString:kNotFound]) return @{ @"ok": @YES, @"exists": @NO };
    return Failure(errorCode);
  }
  struct stat information;
  int result = fstatat(parent, leaf.fileSystemRepresentation, &information, AT_SYMLINK_NOFOLLOW);
  int savedErrno = errno;
  close(parent);
  if (result < 0) {
    if (savedErrno == ENOENT || savedErrno == ENOTDIR) return @{ @"ok": @YES, @"exists": @NO };
    return Failure(CodeForErrno(savedErrno));
  }
  if (S_ISLNK(information.st_mode)) return Failure(kReparsePoint);
  return @{ @"ok": @YES, @"exists": @YES };
}

static NSDictionary *MakeDirectory(NSString *rootPath, NSArray<NSString *> *segments) {
  NSString *errorCode = nil;
  int directory = OpenDirectoryChain(rootPath, segments, YES, &errorCode);
  if (directory < 0) return Failure(errorCode);
  close(directory);
  return Success();
}

static NSDictionary *ListDirectory(NSString *rootPath, NSArray<NSString *> *segments) {
  NSString *errorCode = nil;
  int directory = OpenDirectoryChain(rootPath, segments, NO, &errorCode);
  if (directory < 0) return Failure(errorCode);
  int duplicate = dup(directory);
  if (duplicate < 0) {
    close(directory);
    return Failure(kOpenFailed);
  }
  DIR *stream = fdopendir(duplicate);
  if (!stream) {
    close(duplicate);
    close(directory);
    return Failure(kOpenFailed);
  }
  NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
  struct dirent *entry = NULL;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    NSString *name = [[NSFileManager defaultManager]
      stringWithFileSystemRepresentation:entry->d_name
      length:strlen(entry->d_name)];
    if (!name || !IsSafeSegment(name)) {
      closedir(stream);
      close(directory);
      return Failure(kOpenFailed);
    }
    struct stat information;
    if (fstatat(directory, entry->d_name, &information, AT_SYMLINK_NOFOLLOW) < 0) {
      NSString *code = CodeForErrno(errno);
      closedir(stream);
      close(directory);
      return Failure(code);
    }
    if (S_ISLNK(information.st_mode)) {
      closedir(stream);
      close(directory);
      return Failure(kReparsePoint);
    }
    [entries addObject:@{
      @"name": name,
      @"isDirectory": S_ISDIR(information.st_mode) ? @YES : @NO,
    }];
    if (entries.count > kMaxDirectoryEntries) {
      closedir(stream);
      close(directory);
      return Failure(@"SECURE_FS_DIRECTORY_TOO_LARGE");
    }
  }
  closedir(stream);
  close(directory);
  return @{ @"ok": @YES, @"entries": entries };
}

static int OpenTemporaryFile(int parent, NSString **temporaryName, NSString **errorCode) {
  for (NSUInteger attempt = 0; attempt < 32; attempt++) {
    NSString *candidate = [NSString stringWithFormat:@".ai-novel-%d-%08x.tmp", getpid(), arc4random()];
    int fd = openat(parent, candidate.fileSystemRepresentation,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd >= 0) {
      *temporaryName = candidate;
      return fd;
    }
    if (errno != EEXIST) {
      *errorCode = kWriteFailed;
      return -1;
    }
  }
  *errorCode = kWriteFailed;
  return -1;
}

static BOOL DecodeContent(NSString *encoded, NSData **content, NSString **errorCode) {
  NSUInteger maximumEncodedBytes = ((kMaxTextBytes + 2) / 3) * 4 + 8;
  if (encoded.length > maximumEncodedBytes) {
    *errorCode = @"SECURE_FS_FILE_TOO_LARGE";
    return NO;
  }
  NSData *decoded = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
  if (!decoded) {
    *errorCode = @"SECURE_FS_INVALID_TEXT";
    return NO;
  }
  if (decoded.length > kMaxTextBytes) {
    *errorCode = @"SECURE_FS_FILE_TOO_LARGE";
    return NO;
  }
  *content = decoded;
  return YES;
}

static void WriteAtomically(NSDictionary *request, NSString *rootPath, NSArray<NSString *> *segments) {
  NSString *errorCode = nil;
  NSString *encoded = nil;
  if (!GetString(request, @"contentBase64", &encoded, &errorCode)) {
    WriteResponse(Failure(@"SECURE_FS_INVALID_TEXT"));
    return;
  }
  id required = request[@"mustAlreadyExist"];
  if (required && !IsJsonBoolean(required)) {
    WriteResponse(Failure(@"SECURE_FS_INVALID_OPERATION"));
    return;
  }
  BOOL mustAlreadyExist = required ? [required boolValue] : NO;
  NSData *content = nil;
  if (!DecodeContent(encoded, &content, &errorCode)) {
    WriteResponse(Failure(errorCode));
    return;
  }
  NSString *leaf = nil;
  int parent = OpenParentDirectory(rootPath, segments, &leaf, &errorCode);
  if (parent < 0) {
    WriteResponse(Failure(errorCode));
    return;
  }

  int existing = -1;
  struct stat expected;
  if (mustAlreadyExist) {
    existing = openat(parent, leaf.fileSystemRepresentation, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (existing < 0) {
      WriteResponse(Failure(CodeForErrno(errno)));
      close(parent);
      return;
    }
    if (!RequireRegularFile(existing, &errorCode) || fstat(existing, &expected) < 0) {
      WriteResponse(Failure(errorCode ?: kWriteFailed));
      close(existing);
      close(parent);
      return;
    }
  }

  NSString *temporaryName = nil;
  int temporary = OpenTemporaryFile(parent, &temporaryName, &errorCode);
  if (temporary < 0 || !WriteAll(temporary, content, &errorCode)) {
    if (temporary >= 0) close(temporary);
    if (temporaryName) unlinkat(parent, temporaryName.fileSystemRepresentation, 0);
    if (existing >= 0) close(existing);
    close(parent);
    WriteResponse(Failure(errorCode));
    return;
  }
  close(temporary);

  // The descriptors remain open while the main process checks the project
  // lease. This mirrors the ready/commit boundary used by the Windows helper.
  WriteResponse(@{ @"ok": @YES, @"phase": @"ready" });
  NSDictionary *command = ReadRequest(4096, &errorCode);
  if (!command || ![command[@"command"] isKindOfClass:[NSString class]]
      || ![command[@"command"] isEqualToString:@"commit"]) {
    unlinkat(parent, temporaryName.fileSystemRepresentation, 0);
    if (existing >= 0) close(existing);
    close(parent);
    WriteResponse(Failure(@"SECURE_FS_CANCELLED"));
    return;
  }

  if (mustAlreadyExist) {
    struct stat actual;
    int check = fstatat(parent, leaf.fileSystemRepresentation, &actual, AT_SYMLINK_NOFOLLOW);
    if (check < 0 || S_ISLNK(actual.st_mode)
        || actual.st_dev != expected.st_dev || actual.st_ino != expected.st_ino) {
      unlinkat(parent, temporaryName.fileSystemRepresentation, 0);
      close(existing);
      close(parent);
      WriteResponse(Failure(kWriteFailed));
      return;
    }
  }

  if (renameat(parent, temporaryName.fileSystemRepresentation, parent, leaf.fileSystemRepresentation) < 0) {
    unlinkat(parent, temporaryName.fileSystemRepresentation, 0);
    if (existing >= 0) close(existing);
    close(parent);
    WriteResponse(Failure(kWriteFailed));
    return;
  }
  if (existing >= 0) close(existing);
  close(parent);
  WriteResponse(Success());
}

int main(void) {
  @autoreleasepool {
    NSString *errorCode = nil;
    NSDictionary *request = ReadRequest(kMaxRequestBytes, &errorCode);
    if (!request) {
      WriteResponse(Failure(errorCode));
      return 0;
    }
    NSString *operation = nil;
    NSString *rootPath = nil;
    NSString *relativePath = nil;
    if (!GetString(request, @"operation", &operation, &errorCode)
        || !GetString(request, @"rootPath", &rootPath, &errorCode)
        || !GetString(request, @"relativePath", &relativePath, &errorCode)) {
      WriteResponse(Failure(errorCode));
      return 0;
    }
    NSArray<NSString *> *segments = SegmentsForRelativePath(relativePath, &errorCode);
    if (!segments) {
      WriteResponse(Failure(errorCode));
      return 0;
    }
    if ([operation isEqualToString:@"read"]) {
      WriteResponse(ReadText(rootPath, segments));
    } else if ([operation isEqualToString:@"write"]) {
      WriteAtomically(request, rootPath, segments);
    } else if ([operation isEqualToString:@"mkdir"]) {
      WriteResponse(MakeDirectory(rootPath, segments));
    } else if ([operation isEqualToString:@"exists"]) {
      WriteResponse(Exists(rootPath, segments));
    } else if ([operation isEqualToString:@"list"]) {
      WriteResponse(ListDirectory(rootPath, segments));
    } else {
      WriteResponse(Failure(@"SECURE_FS_INVALID_OPERATION"));
    }
  }
  return 0;
}
