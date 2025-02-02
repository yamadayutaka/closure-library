/**
 * @license
 * Copyright The Closure Library Authors.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview A utility to load JavaScript files via DOM script tags.
 * Refactored from goog.net.Jsonp. Works cross-domain.
 */

goog.provide('goog.net.jsloader');
goog.provide('goog.net.jsloader.Error');
goog.provide('goog.net.jsloader.ErrorCode');
goog.provide('goog.net.jsloader.Options');

goog.require('goog.array');
goog.require('goog.async.Deferred');
goog.require('goog.debug.Error');
goog.require('goog.dom');
goog.require('goog.dom.DomHelper');
goog.require('goog.dom.TagName');
goog.require('goog.dom.safe');
goog.require('goog.html.TrustedResourceUrl');
goog.require('goog.object');


/**
 * The name of the property of goog.global under which the JavaScript
 * verification object is stored by the loaded script.
 * @private {string}
 */
goog.net.jsloader.GLOBAL_VERIFY_OBJS_ = 'closure_verification';


/**
 * The default length of time, in milliseconds, we are prepared to wait for a
 * load request to complete.
 * @type {number}
 */
goog.net.jsloader.DEFAULT_TIMEOUT = 5000;


/**
 * Optional parameters for goog.net.jsloader.send.
 * timeout: The length of time, in milliseconds, we are prepared to wait
 *     for a load request to complete, or 0 or negative for no timeout. Default
 *     is 5 seconds.
 * document: The HTML document under which to load the JavaScript. Default is
 *     the current document.
 * cleanupWhenDone: If true clean up the script tag after script completes to
 *     load. This is important if you just want to read data from the JavaScript
 *     and then throw it away. Default is false.
 * attributes: Additional attributes to set on the script tag.
 *
 * @typedef {{
 *   timeout: (number|undefined),
 *   document: (HTMLDocument|undefined),
 *   cleanupWhenDone: (boolean|undefined),
 *   attributes: (!Object<string, string>|undefined)
 * }}
 */
goog.net.jsloader.Options;


/**
 * Scripts (URIs) waiting to be loaded.
 * @private {!Array<!goog.html.TrustedResourceUrl>}
 */
goog.net.jsloader.scriptsToLoad_ = [];


/**
 * The deferred result of loading the URIs in scriptsToLoad_.
 * We need to return this to a caller that wants to load URIs while
 * a deferred is already working on them.
 * @private {!goog.async.Deferred<null>}
 */
goog.net.jsloader.scriptLoadingDeferred_;



/**
 * Loads and evaluates the JavaScript files at the specified URIs, guaranteeing
 * the order of script loads.
 *
 * Because we have to load the scripts in serial (load script 1, exec script 1,
 * load script 2, exec script 2, and so on), this will be slower than doing
 * the network fetches in parallel.
 *
 * If you need to load a large number of scripts but dependency order doesn't
 * matter, you should just call goog.net.jsloader.safeLoad N times.
 *
 * If you need to load a large number of scripts on the same domain,
 * you may want to use goog.module.ModuleLoader.
 *
 * @param {Array<!goog.html.TrustedResourceUrl>} trustedUris The URIs to load.
 * @param {goog.net.jsloader.Options=} opt_options Optional parameters. See
 *     goog.net.jsloader.options documentation for details.
 * @return {!goog.async.Deferred} The deferred result, that may be used to add
 *     callbacks
 */
goog.net.jsloader.safeLoadMany = function(trustedUris, opt_options) {
  'use strict';
  // Loading the scripts in serial introduces asynchronosity into the flow.
  // Therefore, there are race conditions where client A can kick off the load
  // sequence for client B, even though client A's scripts haven't all been
  // loaded yet.
  //
  // To work around this issue, all module loads share a queue.
  if (!trustedUris.length) {
    return goog.async.Deferred.succeed(null);
  }

  const isAnotherModuleLoading = goog.net.jsloader.scriptsToLoad_.length;
  goog.array.extend(goog.net.jsloader.scriptsToLoad_, trustedUris);
  if (isAnotherModuleLoading) {
    // jsloader is still loading some other scripts.
    // In order to prevent the race condition noted above, we just add
    // these URIs to the end of the scripts' queue and return the deferred
    // result of the ongoing script load, so the caller knows when they
    // finish loading.
    return goog.net.jsloader.scriptLoadingDeferred_;
  }

  trustedUris = goog.net.jsloader.scriptsToLoad_;
  const popAndLoadNextScript = function() {
    'use strict';
    const trustedUri = trustedUris.shift();
    const deferred = goog.net.jsloader.safeLoad(trustedUri, opt_options);
    if (trustedUris.length) {
      deferred.addBoth(popAndLoadNextScript);
    }
    return deferred;
  };
  goog.net.jsloader.scriptLoadingDeferred_ = popAndLoadNextScript();
  return goog.net.jsloader.scriptLoadingDeferred_;
};


/**
 * Loads and evaluates a JavaScript file.
 * When the script loads, a user callback is called.
 * It is the client's responsibility to verify that the script ran successfully.
 *
 * @param {!goog.html.TrustedResourceUrl} trustedUri The URI of the JavaScript.
 * @param {goog.net.jsloader.Options=} opt_options Optional parameters. See
 *     goog.net.jsloader.Options documentation for details.
 * @return {!goog.async.Deferred} The deferred result, that may be used to add
 *     callbacks and/or cancel the transmission.
 *     The error callback will be called with a single goog.net.jsloader.Error
 *     parameter.
 */
goog.net.jsloader.safeLoad = function(trustedUri, opt_options) {
  'use strict';
  const options = opt_options || /** @type {!goog.net.jsloader.Options} */ ({});
  const doc = options.document || document;
  const uri = goog.html.TrustedResourceUrl.unwrap(trustedUri);

  const script =
      new goog.dom.DomHelper(doc).createElement(goog.dom.TagName.SCRIPT);
  const request = {script_: script, timeout_: undefined};
  const deferred = new goog.async.Deferred(goog.net.jsloader.cancel_, request);

  // Set a timeout.
  let timeout = null;
  const timeoutDuration = (options.timeout != null) ?
      options.timeout :
      goog.net.jsloader.DEFAULT_TIMEOUT;
  if (timeoutDuration > 0) {
    timeout = window.setTimeout(function() {
      'use strict';
      goog.net.jsloader.cleanup_(script, true);
      deferred.errback(
          new goog.net.jsloader.Error(
              goog.net.jsloader.ErrorCode.TIMEOUT,
              'Timeout reached for loading script ' + uri));
    }, timeoutDuration);
    request.timeout_ = timeout;
  }

  // Hang the user callback to be called when the script completes to load.
  // NOTE(user): This callback will be called in IE even upon error. In any
  // case it is the client's responsibility to verify that the script ran
  // successfully.
  script.onload = script.onreadystatechange = function() {
    'use strict';
    if (!script.readyState || script.readyState == 'loaded' ||
        script.readyState == 'complete') {
      const removeScriptNode = options.cleanupWhenDone || false;
      goog.net.jsloader.cleanup_(script, removeScriptNode, timeout);
      deferred.callback(null);
    }
  };

  // Add an error callback.
  // NOTE(user): Not supported in IE.
  script.onerror = function() {
    'use strict';
    goog.net.jsloader.cleanup_(script, true, timeout);
    deferred.errback(
        new goog.net.jsloader.Error(
            goog.net.jsloader.ErrorCode.LOAD_ERROR,
            'Error while loading script ' + uri));
  };

  const properties = options.attributes || {};
  goog.object.extend(
      properties, {'type': 'text/javascript', 'charset': 'UTF-8'});
  goog.dom.setProperties(script, properties);
  // NOTE(user): Safari never loads the script if we don't set the src
  // attribute before appending.
  goog.dom.safe.setScriptSrc(script, trustedUri);
  const scriptParent = goog.net.jsloader.getScriptParentElement_(doc);
  scriptParent.appendChild(script);

  return deferred;
};


/**
 * Loads a JavaScript file and verifies it was evaluated successfully, using a
 * verification object.
 * The verification object is set by the loaded JavaScript at the end of the
 * script.
 * We verify this object was set and return its value in the success callback.
 * If the object is not defined we trigger an error callback.
 *
 * @param {!goog.html.TrustedResourceUrl} trustedUri The URI of the JavaScript.
 * @param {string} verificationObjName The name of the verification object that
 *     the loaded script should set.
 * @param {goog.net.jsloader.Options} options Optional parameters. See
 *     goog.net.jsloader.Options documentation for details.
 * @return {!goog.async.Deferred} The deferred result, that may be used to add
 *     callbacks and/or cancel the transmission.
 *     The success callback will be called with a single parameter containing
 *     the value of the verification object.
 *     The error callback will be called with a single goog.net.jsloader.Error
 *     parameter.
 */
goog.net.jsloader.safeLoadAndVerify = function(
    trustedUri, verificationObjName, options) {
  'use strict';
  // Define the global objects variable.
  if (!goog.global[goog.net.jsloader.GLOBAL_VERIFY_OBJS_]) {
    goog.global[goog.net.jsloader.GLOBAL_VERIFY_OBJS_] = {};
  }
  const verifyObjs = goog.global[goog.net.jsloader.GLOBAL_VERIFY_OBJS_];
  const uri = goog.html.TrustedResourceUrl.unwrap(trustedUri);

  // Verify that the expected object does not exist yet.
  if (verifyObjs[verificationObjName] !== undefined) {
    // TODO(user): Error or reset variable?
    return goog.async.Deferred.fail(
        new goog.net.jsloader.Error(
            goog.net.jsloader.ErrorCode.VERIFY_OBJECT_ALREADY_EXISTS,
            'Verification object ' + verificationObjName +
                ' already defined.'));
  }

  // Send request to load the JavaScript.
  const sendDeferred = goog.net.jsloader.safeLoad(trustedUri, options);

  // Create a deferred object wrapping the send result.
  const deferred =
      new goog.async.Deferred(goog.bind(sendDeferred.cancel, sendDeferred));

  // Call user back with object that was set by the script.
  sendDeferred.addCallback(function() {
    'use strict';
    const result = verifyObjs[verificationObjName];
    if (result !== undefined) {
      deferred.callback(result);
      delete verifyObjs[verificationObjName];
    } else {
      // Error: script was not loaded properly.
      deferred.errback(
          new goog.net.jsloader.Error(
              goog.net.jsloader.ErrorCode.VERIFY_ERROR, 'Script ' + uri +
                  ' loaded, but verification object ' + verificationObjName +
                  ' was not defined.'));
    }
  });

  // Pass error to new deferred object.
  sendDeferred.addErrback(function(error) {
    'use strict';
    if (verifyObjs[verificationObjName] !== undefined) {
      delete verifyObjs[verificationObjName];
    }
    deferred.errback(error);
  });

  return deferred;
};


/**
 * Gets the DOM element under which we should add new script elements.
 * How? Take the first head element, and if not found take doc.documentElement,
 * which always exists.
 *
 * @param {!HTMLDocument} doc The relevant document.
 * @return {!Element} The script parent element.
 * @private
 */
goog.net.jsloader.getScriptParentElement_ = function(doc) {
  'use strict';
  const headElements =
      goog.dom.getElementsByTagName(goog.dom.TagName.HEAD, doc);
  if (!headElements || headElements.length === 0) {
    return doc.documentElement;
  } else {
    return headElements[0];
  }
};


/**
 * Cancels a given request.
 * @this {{script_: Element, timeout_: number}} The request context.
 * @private
 */
goog.net.jsloader.cancel_ = function() {
  'use strict';
  const request = this;
  if (request && request.script_) {
    const scriptNode = request.script_;
    if (scriptNode && scriptNode.tagName == goog.dom.TagName.SCRIPT) {
      goog.net.jsloader.cleanup_(scriptNode, true, request.timeout_);
    }
  }
};


/**
 * Removes the script node and the timeout.
 * @param {Node} scriptNode The node to be cleaned up.
 * @param {boolean} removeScriptNode If true completely remove the script node.
 * @param {?number=} opt_timeout The timeout handler to cleanup.
 * @private
 * @suppress {strictMissingProperties} Part of the go/strict_warnings_migration
 */
goog.net.jsloader.cleanup_ = function(
    scriptNode, removeScriptNode, opt_timeout) {
  'use strict';
  if (opt_timeout != null) {
    goog.global.clearTimeout(opt_timeout);
  }

  scriptNode.onload = goog.nullFunction;
  scriptNode.onerror = goog.nullFunction;
  scriptNode.onreadystatechange = goog.nullFunction;

  // Do this after a delay (removing the script node of a running script can
  // confuse older IEs).
  if (removeScriptNode) {
    window.setTimeout(function() {
      'use strict';
      goog.dom.removeNode(scriptNode);
    }, 0);
  }
};


/**
 * Possible error codes for jsloader.
 * @enum {number}
 */
goog.net.jsloader.ErrorCode = {
  LOAD_ERROR: 0,
  TIMEOUT: 1,
  VERIFY_ERROR: 2,
  VERIFY_OBJECT_ALREADY_EXISTS: 3,
};



/**
 * A jsloader error.
 *
 * @param {goog.net.jsloader.ErrorCode} code The error code.
 * @param {string=} opt_message Additional message.
 * @constructor
 * @extends {goog.debug.Error}
 * @final
 */
goog.net.jsloader.Error = function(code, opt_message) {
  'use strict';
  let msg = 'Jsloader error (code #' + code + ')';
  if (opt_message) {
    msg += ': ' + opt_message;
  }
  goog.net.jsloader.Error.base(this, 'constructor', msg);

  /**
   * The code for this error.
   *
   * @type {goog.net.jsloader.ErrorCode}
   */
  this.code = code;
};
goog.inherits(goog.net.jsloader.Error, goog.debug.Error);
