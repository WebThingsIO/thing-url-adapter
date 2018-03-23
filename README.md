# `thing-url-adapter`

This is an adapter add-on for the [Mozilla Things Gateway](https://github.com/mozilla-iot/gateway) that allows a user to discover native web things on their network.

# Manual Installation

This add-on is not currently available via the add-ons list, so manual installation is required. The following instructions are for the official Things Gateway Raspberry Pi image, so you may need to change directory paths as necessary if you're using this elsewhere:

```bash
$ ssh pi@gateway.local
$ cd ~/mozilla-iot/gateway/build/addons
$ git clone https://github.com/mozilla-iot/thing-url-adapter
$ cd thing-url-adapter
$ ./package.sh
$ sudo systemctl restart mozilla-iot-gateway
```

After doing this, you should be able to go into _Settings -> Add-ons_ on the gateway UI and enable the new add-on. After doing so, any discovered devices will show up in the usual "Add Things" screen (_Things -> +_).
