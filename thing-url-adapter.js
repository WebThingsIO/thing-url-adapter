/**
 * example-plugin-adapter.js - ThingURL adapter implemented as a plugin.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const mdns = require('mdns');
const fetch = require('node-fetch');
const EddystoneBeaconScanner = require('eddystone-beacon-scanner');

let Adapter, Device, Property;
try {
  Adapter = require('../adapter');
  Device = require('../device');
  Property = require('../property');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') {
    throw e;
  }

  const gwa = require('gateway-addon');
  Adapter = gwa.Adapter;
  Device = gwa.Device;
  Property = gwa.Property;
}

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
        'Accept': 'application/json',
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
    for (const propertyName in description.properties) {
      const propertyDescription = description.properties[propertyName];
      const property = new ThingURLProperty(this, propertyName,
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
    return fetch(url, {headers: {Accept: 'application/json'}}).then(res => {
      return res.json();
    }).then(thingDescription => {
      let id = url.replace(/[:/]/g, '-');
      url = url.replace(/\/$/, '');
      return this.addDevice(id, url, thingDescription);
    }).catch(e => console.log('Failed to connect to', url, ':', e));
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
        const device =
          new ThingURLDevice(this, deviceId, deviceURL, description);
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
  removeThing(deviceId) {
    return new Promise((resolve, reject) => {
      const device = this.devices[deviceId];
      if (device) {
        this.handleDeviceRemoved(device);
        resolve(device);
      } else {
        reject('Device: ' + deviceId + ' not found.');
      }
    });
  }
}

function startEddystoneDiscovery(adapter) {
  EddystoneBeaconScanner.on('found', function(beacon) {
    if (beacon.type === 'webthing') {
      adapter.loadThing(beacon.url);
    }
  });
  EddystoneBeaconScanner.startScanning();
}

function startDNSDiscovery(adapter) {
  const browser = mdns.createBrowser(mdns.tcp('http', 'webthing'));
  browser.on('serviceUp', (service) => {
    adapter.loadThing(service.txtRecord.url);
  });
  browser.start();
}

function loadThingURLAdapter(addonManager, manifest, _errorCallback) {
  const adapter = new ThingURLAdapter(addonManager, manifest.name);
  startEddystoneDiscovery(adapter);
  startDNSDiscovery(adapter);
}

module.exports = loadThingURLAdapter;
