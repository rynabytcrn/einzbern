// SPDX-License-Identifier: Apache-2.0
// Executed by the system JXA host, never imported by Node. Descriptors are
// opened without following links and bound to the reader's held descriptors by
// exact device/file identity. No source data or caller output FD is inherited.
ObjC.import("Foundation");
ObjC.bindFunction("open", ["int", ["char *", "int"]]);
ObjC.bindFunction("close", ["int", ["int"]]);
ObjC.bindFunction("fgetattrlist", ["int", ["int", "void *", "void *", "unsigned long", "unsigned long"]]);
ObjC.bindFunction("sysctlbyname", ["int", ["char *", "void *", "void *", "void *", "unsigned long"]]);

function run(arguments_) {
  var request = JSON.parse(arguments_[0]);
  var boot = $.NSMutableData.dataWithLength(128);
  var length = $.NSMutableData.alloc.initWithBase64EncodedStringOptions("gAAAAAAAAAA=", 0);
  var bootResult = $.sysctlbyname("kern.bootsessionuuid", boot.mutableBytes, length.mutableBytes, null, 0);
  var records = request.files.map(function (file) {
    // Darwin O_NOFOLLOW | O_NONBLOCK, with O_RDONLY (zero). The Node reader
    // retains its original FD throughout both probes and checks this identity
    // against it, so a different named object never authorizes its bytes.
    var descriptor = $.open(file.path, 0x0104);
    try {
      function attributes(encoded) {
        var list = $.NSData.alloc.initWithBase64EncodedStringOptions(encoded, 0);
        var bytes = $.NSMutableData.dataWithLength(8192);
        var result = $.fgetattrlist(descriptor, list.bytes, bytes.mutableBytes, bytes.length, 32);
        // fgetattrlist stores the actual packed extent in its first uint32.
        // Read that four-byte header before encoding only that validated range;
        // the rest of the fixed-capacity buffer is unreturned zero padding.
        if (result !== 0) return { result: result, bytes: null };
        var header = ObjC.unwrap(bytes.subdataWithRange($.NSMakeRange(0, 4)).base64EncodedStringWithOptions(0));
        var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        var returnedLength = 0, packed = 0, bits = 0, offset = 0;
        for (var i = 0; i < header.length && header[i] !== "="; i++) {
          packed = (packed << 6) | alphabet.indexOf(header[i]);
          bits += 6;
          if (bits >= 8) {
            bits -= 8;
            returnedLength += ((packed >>> bits) & 255) * Math.pow(256, offset++);
          }
        }
        if (offset !== 4 || returnedLength < 24 || returnedLength > bytes.length) return { result: result, bytes: null };
        return { result: result, bytes: ObjC.unwrap(bytes.subdataWithRange($.NSMakeRange(0, returnedLength)).base64EncodedStringWithOptions(0)) };
      }
      var url = $.NSURL.fileURLWithPath(file.path);
      url.removeAllCachedResourceValues;
      var error = Ref();
      var values = url.resourceValuesForKeysError($([
        $.NSURLIsUbiquitousItemKey,
        $.NSURLUbiquitousItemIsDownloadingKey,
        $.NSURLUbiquitousItemDownloadingStatusKey,
        $.NSURLUbiquitousItemDownloadingErrorKey,
        $.NSURLFileResourceIdentifierKey,
      ]), error);
      var resources = {};
      if (values) {
        resources = ObjC.deepUnwrap(values);
        var identity = values.objectForKey($.NSURLFileResourceIdentifierKey);
        resources.NSURLFileResourceIdentifierKey = ObjC.unwrap(identity.description) || null;
        var downloadError = values.objectForKey($.NSURLUbiquitousItemDownloadingErrorKey);
        resources.NSURLUbiquitousItemDownloadingErrorKey = ObjC.unwrap(downloadError.description) || null;
      }
      return {
        file: attributes(request.fileAttributes),
        volume: attributes(request.volumeAttributes),
        resources: resources,
        resourceError: ObjC.unwrap(error[0].description) || null,
      };
    } finally {
      if (descriptor >= 0) $.close(descriptor);
    }
  });
  return JSON.stringify({
    schemaVersion: "einzbern.darwin-source-identity.v1",
    bootResult: bootResult,
    boot: ObjC.unwrap(boot.base64EncodedStringWithOptions(0)),
    files: records,
  });
}
