// var self = require("sdk/self");

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* This file implements the nsIMsgCloudFileProvider interface.
 *
 * This component handles the SeaFile implementation of the
 * nsIMsgCloudFileProvider interface.
 * This code is based of a YouSendIt implementation:
 *   http://mxr.mozilla.org/comm-central/source/mail/components/cloudfile/nsYouSendIt.js
 *
 * Edited by Szabolcs Gyuris (szimszon at oregpreshaz dot eu)
 */

/* jshint moz: true, */

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/gloda/log4moz.js");
Cu.import("resource:///modules/cloudFileAccounts.js");

var gServerUrl = "https://transfer.sh"; // Production url

function nsTranserSh() {
  this.log = Log4Moz.getConfiguredLogger("TransferSh","DEBUG","DEBUG");
}

nsTransferSh.prototype = {
  /* nsISupports */
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIMsgCloudFileProvider]),

  classID: Components.ID("{c5c71fec-3c8f-47ba-aabb-9c1a32a4b08a}"),

  get type() "TransferSh",
  get displayName() "Transfer.sh",
  get serviceURL() gServerUrl,
  get iconClass() "chrome://transfersh/content/terminal.png",
  get lastError() this._lastErrorText,
  // get settingsURL() "chrome://cloudfile-seafile/content/settings.xhtml",
  // get managementURL() "chrome://cloudfile-seafile/content/management.xhtml",

  _prefBranch: null,
  _libraryCreate: "",
  _file : null,
  _requestDate: null,
  _successCallback: null,
  _request: null,
  _maxFileSize : 5368709120,
  _lastErrorStatus : 0,
  _lastErrorText : "",
  _uploadingFile : null,
  _uploader : null,
  _urlsForFiles : {},
  _uploadInfo : {},
  _uploads: [],

  /**
   * Used by our testing framework to override the URLs that this component
   * communicates to.
   */
  overrideUrls: function nsTransferSh_overrideUrls(aNumUrls, aUrls) {
    gServerUrl = aUrls[0];
  },

  /**
   * Initializes an instance of this nsIMsgCloudFileProvider for an account
   * with key aAccountKey.
   *
   * @param aAccountKey the account key to initialize this
   *                    nsIMsgCloudFileProvider with.
   */
  init: function nsTransferSh_init() {
    this._prefBranch = Services.prefs.getBranch("mail.cloud_files.accounts.");
  },

  /**
   * Private callback function passed to, and called from
   * nsTransferShFileUploader.
   *
   * @param aRequestObserver a request observer for monitoring the start and
   *                         stop states of a request.
   * @param aStatus the status of the request.
   */
  _uploaderCallback: function nsTransferSh__uploaderCallback(aRequestObserver,
                                                            aStatus) {
    aRequestObserver.onStopRequest(null, null, aStatus);
    this._uploadingFile = null;
    this._uploads.shift();
    this.log.debug('_uploaderCallback(...,'+aStatus+')');
    if (this._uploads.length > 0) {
      let nextUpload = this._uploads[0];
      this.log.info("_uploaderCallback: chaining upload, file = " + nextUpload.file.leafName);
      this._uploadingFile = nextUpload.file;
      this._uploader = nextUpload;
      try {
        this.uploadFile(nextUpload.file, nextUpload.requestObserver);
      }
      catch (ex) {
        // I'd like to pass ex.result, but that doesn't seem to be defined.
        nextUpload.callback(nextUpload.requestObserver, Cr.NS_ERROR_FAILURE);
      }
    }
    else
      this._uploader = null;
  },

  /**
   * Attempt to upload a file to Tranfer.sh's servers.
   *
   * @param aFile an nsILocalFile for uploading.
   * @param aCallback an nsIRequestObserver for monitoring the start and
   *                  stop states of the upload procedure.
   */
  uploadFile: function nsTransferSh_uploadFile(aFile, aCallback) {
    if (Services.io.offline)
      throw Ci.nsIMsgCloudFileProvider.offlineErr;

    this.log.info("Preparing to upload a file");

    // if we're uploading a file, queue this request.
    if (this._uploadingFile && this._uploadingFile != aFile) {
      this.log.debug("Adding file ["+this._folderName+"/"+aFile.leafName+"] to queue");
      let uploader = new nsTranferShFileUploader(this,
                                                 aFile,
                                                 this._uploaderCallback.bind(this),
                                                 aCallback);
      this._uploads.push(uploader);
      return;
    }

    this._uploadingFile = aFile;
    this._urlListener = aCallback;

    let finish = function() {
      this.log.debug("Call _finishUpload("+aFile.leafName+")");
      this._finishUpload(aFile, aCallback);
    }.bind(this);

    let onInfoSuccess = function() {
      this.finish();
    }.bind(this);

    let onUploadError = function() {
      this._urlListener.onStopRequest(null, null,
                                      Ci.nsIMsgCloudFileProvider.uploadErr);
    }.bind(this);

    onInfoSuccess();
  },

  /**
   * A private function called when we're almost ready to kick off the upload
   * for a file. First, ensures that the file size is not too large, and that
   * we won't exceed our storage quota, and then kicks off the upload.
   *
   * @param aFile the nsILocalFile to upload
   * @param aCallback the nsIRequestObserver for monitoring the start and stop
   *                  states of the upload procedure.
   */
  _finishUpload: function nsTransferSh__finishUpload(aFile, aCallback) {
  this.log.debug("_finishUpload("+aFile.leafName+")");
    if (aFile.fileSize > 5368709120)
      return this._fileExceedsLimit(aCallback, '5GB', 0);
    if (aFile.fileSize > this._maxFileSize)
      return this._fileExceedsLimit(aCallback, 'Limit', 0);

    if (!this._uploader) {
      this.log.debug("_finishUpload: add uploader");
      this._uploader = new nsTransferShFileUploader(aFile, this._uploaderCallback
                                                      .bind(this),
                                                      aCallback);
      this._uploads.unshift(this._uploader);
    }

    this._uploadingFile = aFile;
    this.log.debug("_finishUpload: startUpload()");
    this._uploader.startUpload();
  },

  /**
   * A private function called when upload exceeds file limit.
   *
   * @param aCallback the nsIRequestObserver for monitoring the start and stop
   *                  states of the upload procedure.
   */
  _fileExceedsLimit: function nsTransferSh__fileExceedsLimit(aCallback, aType) {
    let cancel = Ci.nsIMsgCloudFileProvider.uploadCanceled;

    Services.ww.openWindow(null,
                           "chrome://messenger/content/cloudfile/SeaFile/"
                           + "fileExceeds" + aType + ".xul",
                           "TransferSh", "chrome,centerscreen,dialog,modal,resizable=yes")
                           .focus();

    return aCallback.onStopRequest(null, null, cancel);
  },

  /**
   * Cancels an in-progress file upload.
   *
   * @param aFile the nsILocalFile being uploaded.
   */
  cancelFileUpload: function nsTransferSh_cancelFileUpload(aFile) {
    this.log.info("cancelFileUpload("+aFile.leafName+"): in cancel upload");
    if (this._uploadingFile != null && this._uploader != null &&
        this._uploadingFile.equals(aFile)) {
      this._uploader.cancel();
    }
    else {
      for (let i = 0; i < this._uploads.length; i++)
        if (this._uploads[i].file.equals(aFile)) {
          this._uploads[i].requestObserver.onStopRequest(
            null, null, Ci.nsIMsgCloudFileProvider.uploadCanceled);
          this._uploads.splice(i, 1);
          return;
        }
    }
  },

  /**
   * Returns the sharing URL for some uploaded file.
   *
   * @param aFile the nsILocalFile to get the URL for.
   */
  urlForFile: function nsTransferSh_urlForFile(aFile) {
    return this._urlsForFiles[aFile.path];
  },

  /**
   * Returns an appropriate provider-specific URL for dealing with a particular
   * error type.
   *
   * @param aError an error to get the URL for.
   */
  providerUrlForError: function nsTransferSh_providerUrlForError(aError) {
    return gServerUrl;
  },

  /**
   * If we don't know the limit, this will return -1.
   */
  get fileUploadSizeLimit() this._maxFileSize,

  /**
   * Attempts to delete an uploaded file.
   *
   * @param aFile the nsILocalFile to delete.
   * @param aCallback an nsIRequestObserver for monitoring the start and stop
   *                  states of the delete procedure.
   */
  // deleteFile: function nsTransferSh_deleteFile(aFile, aCallback) {
  //   this.log.debug("deleteFile("+aFile.leafName+"): Deleting a file");
  //
  //   if (Services.io.offline) {
  //     this.log.error("We're offline - we can't delete the file.");
  //     throw Ci.nsIMsgCloudFileProvider.offlineErr;
  //   }
  //
  //   let uploadInfo = this._uploadInfo[aFile.path];
  //   if (!uploadInfo) {
  //     this.log.error("deleteFile: Could not find a record for the file ["+aFile.leafName+"] to be deleted.");
  //     throw Cr.NS_ERROR_FAILURE;
  //   }
  //
  //   let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
  //               .createInstance(Ci.nsIXMLHttpRequest);
  //   this._getRepoId();
  //   let args = kRepoPath + this._repoId + "/file/?p="+this._folderName+"/"+
  //              aFile.leafName;
  //
  //   req.open("DELETE", gServerUrl + args, true);
  //   this.log.debug("deleteFile: Sending delete request to: " + gServerUrl + args);
  //
  //   req.onerror = function() {
  //     let response = JSON.parse(req.responseText);
  //     this._lastErrorStatus = req.status;
  //     this._lastErrorText = response.detail;
  //     this.log.error("deleteFile: There was a problem deleting a file ["+aFile.leafName+"]: " + this._lastErrorText);
  //     aCallback.onStopRequest(null, null, Cr.NS_ERROR_FAILURE);
  //   }.bind(this);
  //
  //   req.onload = function() {
  //     // Response is the URL.
  //     let response = req.responseText;
  //     this.log.debug("deleteFile: delete response = " + response);
  //     let deleteInfo = JSON.parse(response);
  //
  //     if ( req.status >= 200 && req.status < 400 ) {
  //       this.log.debug("deleteFile: Delete was successful! ["+aFile.leafName+"]");
  //       // Success!
  //       aCallback.onStopRequest(null, null, Cr.NS_OK);
  //     }
  //     else
  //     {
  //       this.log.error("deleteFile: Server has returned a failure on our delete request.");
  //       this.log.error("deleteFile: Error code: " + req.status);
  //       this.log.error("deleteFile: Error message: " + deleteInfo.detail);
  //       //aCallback.onStopRequest(null, null,
  //       //                        Ci.nsIMsgCloudFileProvider.uploadErr);
  //       return;
  //     }
  //
  //   }.bind(this);
  //   req.setRequestHeader("Authorization", "Token "+this._cachedAuthToken + " ");
  //   req.setRequestHeader("Accept", "application/json");
  //   req.send();
  // },

  /**
   * Attempt to log on and get the auth token for this SeaFile account.
   *
   * @param successCallback the callback to be fired if logging on is successful
   * @param failureCallback the callback to be fired if loggong on fails
   * @aparam aWithUI a boolean for whether or not we should prompt for a password
   *                 if no auth token is currently stored.
   */

function nsTransferShFileUploader(aTransferSh, aFile, aCallback,
                                   aRequestObserver) {
  this.transferSh = aTransferSh;
  this.log = this.transferSh.log;
  this.log.debug("nsTransferShFileUploader("+ aFile.leafName + ")");
  this.file = aFile;
  this.callback = aCallback;
  this.requestObserver = aRequestObserver;
}

nsTransferShFileUploader.prototype = {
  transferSh : null,
  file : null,
  callback : null,
  _request : null,

  /**
   * Kicks off the upload procedure for this uploader.
   **/
  startUpload: function nsSFU_startUpload() {
  this.log.debug('startUpload('+this.folderName+','+this.file.leafName+')');
    let curDate = Date.now().toString();

    this.requestObserver.onStartRequest(null, null);

    let onSuccess = function() {
      this._uploadFile();
    }.bind(this);

    let onFailure = function() {
      this.callback(this.requestObserver, Ci.nsIMsgCloudFileProvider.uploadErr);
    }.bind(this);

    return this._prepareToSend(onSuccess, onFailure);
  },

  /**
   * This function actually does
   * the upload of the file to SeaFile.
   */
  _uploadFile: function nsSFU__uploadFile() {
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);

    this.log.debug("_uploadFile: "+this.file.leafName);
    let curDate = Date.now().toString();
    this.log.debug("_uploadFile("+this.file.leafName+"): upload url = " + gServerUrl);
    this.request = req;
    req.open("POST", gServerUrl, true);
    let uploadInfo="";
    req.onload = function() {
      this.cleanupTempFile();
      if (req.status >= 200 && req.status < 400) {
        try {
          this.log.debug("_uploadFile("+this.file.leafName+"): upload response = " + req.responseText);
          uploadInfo = req.responseText;
        } catch (ex) {
          this.log.error(ex);
        }
      }
      else
      {
      this.log.error("_uploadFile("+this.file.leafName+"): error - "+req.responseText);
        this.callback(this.requestObserver,
                      Ci.nsIMsgCloudFileProvider.uploadErr);
      }
    }.bind(this);

    req.onerror = function () {
      this.cleanupTempFile();
      if (this.callback)
        this.callback(this.requestObserver,
                      Ci.nsIMsgCloudFileProvider.uploadErr);
    }.bind(this);

    req.setRequestHeader("Date", curDate);
    let boundary = "------" + curDate;
    let contentType = "multipart/form-data; boundary="+ boundary;
    req.setRequestHeader("Content-Type", contentType+"; charset=utf-8");

    let fileName = /^[\040-\176]+$/.test(this.file.leafName)
       ? this.file.leafName
       : encodeURIComponent(this.file.leafName);

    fileContents += "\r\n--" + boundary +
      "\r\nContent-Disposition: form-data; name=\"fname\"; filename=\"" +
      fileName + "\"\r\nContent-Type: application/octet-stream" +
      "\r\n\r\n";

    // Since js doesn't like binary data in strings, we're going to create
    // a temp file consisting of the message preamble, the file contents, and
    // the post script, and pass a stream based on that file to
    // nsIXMLHttpRequest.send().

    try {
      this._tempFile = this.getTempFile(this.file.leafName);
      let ostream = Cc["@mozilla.org/network/file-output-stream;1"]
                     .createInstance(Ci.nsIFileOutputStream);
      ostream.init(this._tempFile, -1, -1, 0);
      ostream.write(fileContents, fileContents.length);

      this._fstream = Cc["@mozilla.org/network/file-input-stream;1"]
                       .createInstance(Ci.nsIFileInputStream);
      let sstream = Cc["@mozilla.org/scriptableinputstream;1"]
                       .createInstance(Ci.nsIScriptableInputStream);
      this._fstream.init(this.file, -1, 0, 0);
      sstream.init(this._fstream);

      // This blocks the UI which is less than ideal. But it's a local
      // file operations so probably not the end of the world.
      while (sstream.available() > 0) {
        let bytes = sstream.readBytes(sstream.available());
        ostream.write(bytes, bytes.length);
      }

      fileContents = "\r\n--" + boundary + "--\r\n";
      ostream.write(fileContents, fileContents.length);

      ostream.close();
      this._fstream.close();
      sstream.close();

      // defeat fstat caching
      this._tempFile = this._tempFile.clone();
      this._fstream.init(this._tempFile, -1, 0, 0);
      this._fstream.close();
      // I don't trust re-using the old fstream.
      this._fstream = Cc["@mozilla.org/network/file-input-stream;1"]
                     .createInstance(Ci.nsIFileInputStream);
      this._fstream.init(this._tempFile, -1, 0, 0);
      this._bufStream = Cc["@mozilla.org/network/buffered-input-stream;1"]
                        .createInstance(Ci.nsIBufferedInputStream);
      this._bufStream.init(this._fstream, 4096);
      // nsIXMLHttpRequest's nsIVariant handling requires that we QI
      // to nsIInputStream.
      req.send(this._bufStream.QueryInterface(Ci.nsIInputStream));
    } catch (ex) {
      this.cleanupTempFile();
      this.log.error(ex);
      throw ex;
    }
  },

  /**
   * Cancels the upload request for the file associated with this Uploader.
   */
  cancel: function nsSFU_cancel() {
    this.log.debug("cancel("+this.file.leafName+"): in uploader cancel");
    this.callback(this.requestObserver, Ci.nsIMsgCloudFileProvider.uploadCanceled);
    delete this.callback;
    if (this.request) {
      this.log.debug("cancel("+this.file.leafName+"): cancelling upload request");
      let req = this.request;
      if (req.channel) {
        this.log.debug("cancel("+this.file.leafName+"): cancelling upload channel");
        req.channel.cancel(Cr.NS_BINDING_ABORTED);
      }
      this.request = null;
    }
  },

  /**
   * Creates and returns a temporary file on the local file system.
   */
  getTempFile: function nsSFU_getTempFile(leafName) {
    let tempfile = Services.dirsvc.get("TmpD", Ci.nsIFile);
    tempfile.append(leafName)
    tempfile.createUnique(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, parseInt("0666", 8));
    // do whatever you need to the created file
    return tempfile.clone()
  },

  /**
   * Cleans up any temporary files that this nsTransferShFileUploader may have
   * created.
   */
  cleanupTempFile: function nsSFU_cleanupTempFile() {
    if (this._bufStream)
      this._bufStream.close();
    if (this._fstream)
      this._fstream.close();
    if (this._tempFile)
      this._tempFile.remove(false);
  },
};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([nsTransferSh]);
