/**
 * @license
 * Copyright The Closure Library Authors.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Provides data persistence using IE userData mechanism.
 * UserData uses proprietary Element.addBehavior(), Element.load(),
 * Element.save(), and Element.XMLDocument() methods, see:
 * http://msdn.microsoft.com/en-us/library/ms531424(v=vs.85).aspx.
 */


// TODO(user): We're trying to migrate all ES5 subclasses of Closure
// Library to ES6. In ES6 this cannot be referenced before super is called. This
// file has at least one this before a super call (in ES5) and cannot be
// automatically upgraded to ES6 as a result. Please fix this if you have a
// chance. Note: This can sometimes be caused by not calling the super
// constructor at all. You can run the conversion tool yourself to see what it
// does on this file: blaze run //javascript/refactoring/es6_classes:convert.

goog.provide('goog.storage.mechanism.IEUserData');

goog.require('goog.asserts');
goog.require('goog.iter');
goog.require('goog.iter.Iterator');
goog.require('goog.storage.mechanism.ErrorCode');
goog.require('goog.storage.mechanism.IterableMechanism');
goog.require('goog.structs.Map');
goog.require('goog.userAgent');



/**
 * Provides a storage mechanism using IE userData.
 *
 * @param {string} storageKey The key (store name) to store the data under.
 * @param {string=} opt_storageNodeId The ID of the associated HTML element,
 *     one will be created if not provided.
 * @constructor
 * @extends {goog.storage.mechanism.IterableMechanism}
 * @final
 */
goog.storage.mechanism.IEUserData = function(storageKey, opt_storageNodeId) {
  'use strict';
  /**
   * The key to store the data under.
   *
   * @private {string}
   */
  this.storageKey_ = storageKey;

  /**
   * The document element used for storing data.
   *
   * @private {?Element}
   */
  this.storageNode_ = null;

  goog.storage.mechanism.IEUserData.base(this, 'constructor');

  // Tested on IE6, IE7 and IE8. It seems that IE9 introduces some security
  // features which make persistent (loaded) node attributes invisible from
  // JavaScript.
  if (goog.userAgent.IE && !goog.userAgent.isDocumentModeOrHigher(9)) {
    if (!goog.storage.mechanism.IEUserData.storageMap_) {
      goog.storage.mechanism.IEUserData.storageMap_ = new goog.structs.Map();
    }
    this.storageNode_ = /** @type {Element} */ (
        goog.storage.mechanism.IEUserData.storageMap_.get(storageKey));
    if (!this.storageNode_) {
      if (opt_storageNodeId) {
        this.storageNode_ = document.getElementById(opt_storageNodeId);
      } else {
        this.storageNode_ = document.createElement('userdata');
        // This is a special IE-only method letting us persist data.
        this.storageNode_['addBehavior']('#default#userData');
        document.body.appendChild(this.storageNode_);
      }
      goog.storage.mechanism.IEUserData.storageMap_.set(
          storageKey, this.storageNode_);
    }


    try {
      // Availability check.
      this.loadNode_();
    } catch (e) {
      this.storageNode_ = null;
    }
  }
};
goog.inherits(
    goog.storage.mechanism.IEUserData,
    goog.storage.mechanism.IterableMechanism);


/**
 * Encoding map for characters which are not encoded by encodeURIComponent().
 * See encodeKey_ documentation for encoding details.
 *
 * @type {!Object}
 * @const
 */
goog.storage.mechanism.IEUserData.ENCODE_MAP = {
  '.': '.2E',
  '!': '.21',
  '~': '.7E',
  '*': '.2A',
  '\'': '.27',
  '(': '.28',
  ')': '.29',
  '%': '.'
};


/**
 * Global storageKey to storageNode map, so we save on reloading the storage.
 *
 * @type {?goog.structs.Map}
 * @private
 */
goog.storage.mechanism.IEUserData.storageMap_ = null;


/**
 * Encodes anything other than [-a-zA-Z0-9_] using a dot followed by hex,
 * and prefixes with underscore to form a valid and safe HTML attribute name.
 *
 * We use URI encoding to do the initial heavy lifting, then escape the
 * remaining characters that we can't use. Since a valid attribute name can't
 * contain the percent sign (%), we use a dot (.) as an escape character.
 *
 * @param {string} key The key to be encoded.
 * @return {string} The encoded key.
 * @private
 */
goog.storage.mechanism.IEUserData.encodeKey_ = function(key) {
  'use strict';
  // encodeURIComponent leaves - _ . ! ~ * ' ( ) unencoded.
  return '_' + encodeURIComponent(key).replace(/[.!~*'()%]/g, function(c) {
    'use strict';
    return goog.storage.mechanism.IEUserData.ENCODE_MAP[c];
  });
};


/**
 * Decodes a dot-encoded and character-prefixed key.
 * See encodeKey_ documentation for encoding details.
 *
 * @param {string} key The key to be decoded.
 * @return {string} The decoded key.
 * @private
 */
goog.storage.mechanism.IEUserData.decodeKey_ = function(key) {
  'use strict';
  return decodeURIComponent(key.replace(/\./g, '%')).substr(1);
};


/**
 * Determines whether or not the mechanism is available.
 *
 * @return {boolean} True if the mechanism is available.
 */
goog.storage.mechanism.IEUserData.prototype.isAvailable = function() {
  'use strict';
  return !!this.storageNode_;
};


/** @override */
goog.storage.mechanism.IEUserData.prototype.set = function(key, value) {
  'use strict';
  this.storageNode_.setAttribute(
      goog.storage.mechanism.IEUserData.encodeKey_(key), value);
  this.saveNode_();
};


/** @override */
goog.storage.mechanism.IEUserData.prototype.get = function(key) {
  'use strict';
  // According to Microsoft, values can be strings, numbers or booleans. Since
  // we only save strings, any other type is a storage error. If we returned
  // nulls for such keys, i.e., treated them as non-existent, this would lead
  // to a paradox where a key exists, but it does not when it is retrieved.
  // http://msdn.microsoft.com/en-us/library/ms531348(v=vs.85).aspx
  var value = this.storageNode_.getAttribute(
      goog.storage.mechanism.IEUserData.encodeKey_(key));
  if (typeof value !== 'string' && value !== null) {
    throw goog.storage.mechanism.ErrorCode.INVALID_VALUE;
  }
  return value;
};


/** @override */
goog.storage.mechanism.IEUserData.prototype.remove = function(key) {
  'use strict';
  this.storageNode_.removeAttribute(
      goog.storage.mechanism.IEUserData.encodeKey_(key));
  this.saveNode_();
};


/** @override */
goog.storage.mechanism.IEUserData.prototype.getCount = function() {
  'use strict';
  return this.getNode_().attributes.length;
};


/** @override */
goog.storage.mechanism.IEUserData.prototype.__iterator__ = function(opt_keys) {
  'use strict';
  var i = 0;
  var attributes = this.getNode_().attributes;
  var newIter = new goog.iter.Iterator();
  /**
   * @return {!IIterableResult<string>}
   * @override
   */
  newIter.next = function() {
    'use strict';
    if (i >= attributes.length) {
      return goog.iter.ES6_ITERATOR_DONE;
    }
    var item = goog.asserts.assert(attributes[i++]);
    if (opt_keys) {
      return goog.iter.createEs6IteratorYield(
          goog.storage.mechanism.IEUserData.decodeKey_(item.nodeName));
    }
    var value = item.nodeValue;
    // The value must exist and be a string, otherwise it is a storage error.
    if (typeof value !== 'string') {
      throw goog.storage.mechanism.ErrorCode.INVALID_VALUE;
    }
    return goog.iter.createEs6IteratorYield(value);
  };

  return newIter;
};


/** @override */
goog.storage.mechanism.IEUserData.prototype.clear = function() {
  'use strict';
  var node = this.getNode_();
  for (var left = node.attributes.length; left > 0; left--) {
    node.removeAttribute(node.attributes[left - 1].nodeName);
  }
  this.saveNode_();
};


/**
 * Loads the underlying storage node to the state we saved it to before.
 *
 * @private
 */
goog.storage.mechanism.IEUserData.prototype.loadNode_ = function() {
  'use strict';
  // This is a special IE-only method on Elements letting us persist data.
  this.storageNode_['load'](this.storageKey_);
};


/**
 * Saves the underlying storage node.
 *
 * @private
 */
goog.storage.mechanism.IEUserData.prototype.saveNode_ = function() {
  'use strict';
  try {
    // This is a special IE-only method on Elements letting us persist data.
    // Do not try to assign this.storageNode_['save'] to a variable, it does
    // not work. May throw an exception when the quota is exceeded.
    this.storageNode_['save'](this.storageKey_);
  } catch (e) {
    throw goog.storage.mechanism.ErrorCode.QUOTA_EXCEEDED;
  }
};


/**
 * Returns the storage node.
 *
 * @return {!Element} Storage DOM Element.
 * @private
 */
goog.storage.mechanism.IEUserData.prototype.getNode_ = function() {
  'use strict';
  // This is a special IE-only property letting us browse persistent data.
  var doc = /** @type {Document} */ (this.storageNode_['XMLDocument']);
  return doc.documentElement;
};
