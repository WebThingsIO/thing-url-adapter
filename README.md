# thing-url-adapter

This is an adapter add-on for the [Mozilla WebThings Gateway](https://github.com/mozilla-iot/gateway) that allows a user to discover native web things on their network.

## m2ag-labs fork
   * Adds support for jwt authentication for restful and websocket connections to webthings. 
   * Configuration is via a jwt_auth.json file in .mozilla-iot/config
   * jwt support is disabled if no file found. 
   * A thing that requires a jwt but has none configured will show up as an undefined thing in the gateway.  

   File format:
   `{
        "<hotsname>:<port>" : "<jwt-token>"
    }`
 
    Example: {"raspib.local:8888" : "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzb21lIjoicGF5b$"}
   Compatibility:
   Tested with the m2ag-labs fork of the [webthing-python](https://github.com/m2ag-labs/webthing-python) project.  
   
   Installation:
   * Remove the downloaded version of the webthings adapter. 
   * Clone this project into the .mozilla-iot/addons directory. 
   * run npm install in the thing-url-adapter directory.
   * Create the jwt_auth.json in .mozilla-iot/config. 
   * Gateway will need to be restarted when jwts  are added.
   * Create jwt with code similar to [this](https://github.com/m2ag-labs/m2ag-thing/blob/master/api/helpers/auth.py)  
   
## Adding Web Things to Gateway
* Usually, your custom web things should be auto-detected on the network via mDNS, so they should appear in the usual "Add Devices" screen.
* If they're not auto-detected, you can click "Add by URL..." at the bottom of the page and use the URL of your web thing.
    * If you're trying to add a server that contains multiple web things, i.e. the "multiple-things" examples from the [webthing-python](https://github.com/mozilla-iot/webthing-python), [webthing-node](https://github.com/mozilla-iot/webthing-node), or [webthing-java](https://github.com/mozilla-iot/webthing-java) libraries, you'll have to add them individually. You can do so by addressing them numerically, i.e. `http://myserver.local:8888/0` and `http://myserver.local:8888/1`.
