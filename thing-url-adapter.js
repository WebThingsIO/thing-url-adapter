/**
 * example-plugin-adapter.js - ThingURL adapter implemented as a plugin.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const fetch = require('node-fetch');

const Adapter = require('../adapter');
const Device = require('../device');
const Property = require('../property');

const urls = [
  'http://esp8266.local'
];

class ThingURLProperty extends Property {
  constructor(device, name, propertyDescription) {
    super(device, name, propertyDescription);
    this.unit = propertyDescription.unit;
    this.url = device.url + propertyDescription.href;
    this.description = propertyDescription.description;
    this.setCachedValue(propertyDescription.value);
    this.device.notifyPropertyChanged(this);
  }

  /**
   * @method setValue
   * @returns {Promise} resolves to the updated value
   *
   * @note it is possible that the updated value doesn't match
   * the value passed in.
   */
  setValue(value) {
    return fetch(this.url, {
      method: 'PUT',
      headers: {
        'Content-type': 'application/json',
      },
      body: JSON.stringify({
        [this.name]: value
      })
    }).then(res => {
      return res.json();
    }).then(response => {
      let updatedValue = response[this.name];
      this.setCachedValue(updatedValue);
      this.device.notifyPropertyChanged(this);
      return updatedValue;
    });
  }
}

class ThingURLDevice extends Device {
  constructor(adapter, id, url, description) {
    super(adapter, id);
    this.name = description.name;
    this.type = description.type;
    this.url = url;
    this.description = description.description;
    for (var propertyName in description.properties) {
      var propertyDescription = description.properties[propertyName];
      var property = new ThingURLProperty(this, propertyName,
                                        propertyDescription);
      this.properties.set(propertyName, property);
    }
  }
}

class ThingURLAdapter extends Adapter {
  constructor(addonManager, packageName) {
    super(addonManager, 'ThingURLPlugin', packageName);
    addonManager.addAdapter(this);
  }

  loadThing(url) {
    return fetch(url).then(res => {
      return res.json();
    }).then(thingDescription => {
      let id = url.replace(/[:\/]/g, '-');
      return this.addDevice(id, url, thingDescription);
    });
  }

  /**
   * Add a ThingURLDevice to the ThingURLAdapter
   *
   * @param {String} deviceId ID of the device to add.
   * @return {Promise} which resolves to the device added.
   */
  addDevice(deviceId, deviceURL, description) {
    return new Promise((resolve, reject) => {
      if (deviceId in this.devices) {
        reject('Device: ' + deviceId + ' already exists.');
      } else {
        var device = new ThingURLDevice(this, deviceId, deviceURL, description);
        this.handleDeviceAdded(device);
        resolve(device);
      }
    });
  }

  /**
   * Remove a ThingURLDevice from the ThingURLAdapter.
   *
   * @param {String} deviceId ID of the device to remove.
   * @return {Promise} which resolves to the device removed.
   */
  removeDevice(deviceId) {
    return new Promise((resolve, reject) => {
      var device = this.devices[deviceId];
      if (device) {
        this.handleDeviceRemoved(device);
        resolve(device);
      } else {
        reject('Device: ' + deviceId + ' not found.');
      }
    });
  }
}

function loadThingURLAdapter(addonManager, manifest, _errorCallback) {
  var adapter = new ThingURLAdapter(addonManager, manifest.name);
  for (let url of urls) {
    adapter.loadThing(url);
  }
}

module.exports = loadThingURLAdapter;
