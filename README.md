# thing-url-adapter

This is an adapter add-on for the [Mozilla WebThings Gateway](https://github.com/mozilla-iot/gateway) that allows a user to discover native web things on their network.

## Adding Web Things to Gateway

* Usually, your custom web things should be auto-detected on the network via mDNS, so they should appear in the usual "Add Devices" screen.
* If they're not auto-detected, you can click "Add by URL..." at the bottom of the page and use the URL of your web thing.
    * If you're trying to add a server that contains multiple web things, i.e. the "multiple-things" examples from the [webthing-python](https://github.com/mozilla-iot/webthing-python), [webthing-node](https://github.com/mozilla-iot/webthing-node), or [webthing-java](https://github.com/mozilla-iot/webthing-java) libraries, you'll have to add them individually. You can do so by addressing them numerically, i.e. `http://myserver.local:8888/0` and `http://myserver.local:8888/1`.
