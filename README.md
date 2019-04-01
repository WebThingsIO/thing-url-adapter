# thing-url-adapter

This is an adapter add-on for the [Mozilla WebThings Gateway](https://github.com/mozilla-iot/gateway) that allows a user to discover native web things on their network.

## Notes

If you're trying to **MANUALLY** add a server (e.g. if mDNS discovery isn't working) that contains multiple web things, i.e. the "multiple-things" examples from the [webthing-python](https://github.com/mozilla-iot/webthing-python), [webthing-node](https://github.com/mozilla-iot/webthing-node), or [webthing-java](https://github.com/mozilla-iot/webthing-java) libraries, you'll have to add them individually. You can do so by addressing them numerically, i.e. `http://myserver.local:8888/0` and `http://myserver.local:8888/1`.
