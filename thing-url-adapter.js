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
const {URL} = require('url');

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
  constructor(device, name, url, propertyDescription) {
    super(device, name, propertyDescription);
    this.url = url;
    this.unit = propertyDescription.unit;
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
    this.propertyPromises = [];

    const baseUrl = new URL(url).origin;
    for (const propertyName in description.properties) {
      const propertyDescription = description.properties[propertyName];
      const propertyUrl = baseUrl + propertyDescription.href;
      this.propertyPromises.push(
        fetch(propertyUrl, {
          headers: {
            Accept: 'application/json',
          },
        }).then(res => {
          return res.json();
        }).then(res => {
          propertyDescription.value = res[propertyName];
          const property = new ThingURLProperty(
            this, propertyName, propertyUrl, propertyDescription);
          this.properties.set(propertyName, property);
        }).catch(e => {
          console.log('Failed to connect to', propertyUrl, ':', e);
        }));
    }
  }
}

class ThingURLAdapter extends Adapter {
  constructor(addonManager, packageName) {
    super(addonManager, 'ThingURLPlugin', packageName);
    addonManager.addAdapter(this);
    this.knownUrls = new Set();
  }

  loadThing(url) {
    url = url.replace(/\/$/, '');

    if (this.knownUrls.has(url)) {
      return;
    }

    this.knownUrls.add(url);

    return fetch(url, {headers: {Accept: 'application/json'}}).then(res => {
      return res.json();
    }).then(data => {
      let things;
      if (Array.isArray(data)) {
        things = data;
      } else {
        things = [data];
      }

      for (const thingDescription of things) {
        let thingUrl = url;
        if (thingDescription.hasOwnProperty('href')) {
          const baseUrl = new URL(url).origin;
          thingUrl = baseUrl + thingDescription.href;
        }

        let id = thingUrl.replace(/[:/]/g, '-');
        this.addDevice(id, thingUrl, thingDescription);
      }
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
        Promise.all(device.propertyPromises).then(() => {
          this.handleDeviceAdded(device);
          resolve(device);
        }).catch(e => reject(e));
      }
    });
  }

  /**
   * Remove a ThingURLDevice from the ThingURLAdapter.
   *
   * @param {Object} device The device to remove.
   * @return {Promise} which resolves to the device removed.
   */
  removeThing(device) {
    return new Promise((resolve, reject) => {
      if (this.devices.hasOwnProperty(device.id)) {
        this.handleDeviceRemoved(device);
        resolve(device);
      } else {
        reject('Device: ' + device.id + ' not found.');
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

  for (const url of manifest.moziot.config.urls) {
    adapter.loadThing(url);
  }

  startEddystoneDiscovery(adapter);
  startDNSDiscovery(adapter);
}

module.exports = loadThingURLAdapter;
