// SPDX-License-Identifier: Apache-2.0
// Executed by the system JXA host, never imported by Node. Descriptors are
// inherited from the reader; this helper opens no source and reads no data.
ObjC.import("Foundation");
ObjC.bindFunction("fgetattrlist", ["int", ["int", "void *", "void *", "unsigned long", "unsigned long"]]);
ObjC.bindFunction("sysctlbyname", ["int", ["char *", "void *", "void *", "void *", "unsigned long"]]);

function run(arguments_) {
  var request = JSON.parse(arguments_[0]);
  var boot = $.NSMutableData.dataWithLength(128);
  var length = $.NSMutableData.alloc.initWithBase64EncodedStringOptions("gAAAAAAAAAA=", 0);
  var bootResult = $.sysctlbyname("kern.bootsessionuuid", boot.mutableBytes, length.mutableBytes, null, 0);
  var records = request.files.map(function (file) {
    function attributes(encoded) {
      var list = $.NSData.alloc.initWithBase64EncodedStringOptions(encoded, 0);
      var bytes = $.NSMutableData.dataWithLength(8192);
      var result = $.fgetattrlist(file.fd, list.bytes, bytes.mutableBytes, bytes.length, 32);
      return { result: result, bytes: ObjC.unwrap(bytes.base64EncodedStringWithOptions(0)) };
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
  });
  return JSON.stringify({
    schemaVersion: "einzbern.darwin-source-identity.v1",
    bootResult: bootResult,
    boot: ObjC.unwrap(boot.base64EncodedStringWithOptions(0)),
    files: records,
  });
}
