# thing-url-adapter

This is an adapter add-on for the [WebThings Gateway](https://github.com/WebThingsIO/gateway) that allows a user to discover native web things on their network.

## Adding Web Things to Gateway
* Usually, your custom web things should be auto-detected on the network via mDNS, so they should appear in the usual "Add Devices" screen.
* If they're not auto-detected, you can click "Add by URL..." at the bottom of the page and use the URL of your web thing.
    * If you're trying to add a server that contains multiple web things, i.e. the "multiple-things" examples from the [webthing-python](https://github.com/WebThingsIO/webthing-python), [webthing-node](https://github.com/WebThingsIO/webthing-node), or [webthing-java](https://github.com/WebThingsIO/webthing-java) libraries, you'll have to add them individually. You can do so by addressing them numerically, i.e. `http://myserver.local:8888/0` and `http://myserver.local:8888/1`.

## Secure Web Things
* Web Things that require jwt, basic or digest authentication can be supported by adding configuration options on the adapter page.
* To add a secure Web Thing:

    * Use the hamburger to open the side menu and select "Settings".

    ![select_settings.png](images/select_settings.png)

    * Select "Add-ons".

    ![select_addons.png](images/select_addons.png)

    * Find the Web Thing adapter and select "Configure".

    ![select_configure.png](images/select_configure.png)

    * Enter data relevant to the desired authentication method.
    * To manually enter device URLs with no authentication select 'none' for the method.

    ![enter_data.png](images/enter_data.png)

    * Save the entry by pressing "Apply" at the bottom of the page.
