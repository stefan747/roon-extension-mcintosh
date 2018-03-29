"use strict";

var McIntosh             = require("node-mcintosh"),
    RoonApi              = require("node-roon-api"),
    RoonApiSettings      = require('node-roon-api-settings'),
    RoonApiStatus        = require('node-roon-api-status'),
    RoonApiVolumeControl = require('node-roon-api-volume-control'),
    RoonApiSourceControl = require('node-roon-api-source-control');

var roon = new RoonApi({
    extension_id:        'com.stefan747.roon.mcintosh',
    display_name:        'McIntosh Volume/Source Control',
    display_version:     "1.0.0",
    publisher:           'Stefan Kruzlik',
    email:               'stefan.kruzlik@gmail.com',
    website:             'https://github.com/stefan747/roon-extension-mcintosh',
});

var mysettings = roon.load_config("settings") || {
    serialport:    "",
    setsource:     "8",
    initialvolume: 10,
	startuptime: 7
};

var mcintosh = { };

function makelayout(settings) {
    var l = {
        values:    settings,
	layout:    [],
	has_error: false
    };

        l.layout.push({
            type:      "string",
            title:     "Serial Port",
            maxlength: 256,
            setting:   "serialport",
        });
    
    l.layout.push({
        type:    "dropdown",
        title:   "Source for Convenience Switch",
        values:  [
            { value: "8", title: "USB"          },
            { value: "4", title: "CD"           },
            { value: "3", title: "TV"           }
        ],
        setting: "setsource",
    });
	
    l.layout.push({
        type:    "integer",
        title:   "Initial Volume",
	min:     0,
	max:     100,
        setting: "initialvolume",
    });

    l.layout.push({
        type:    "integer",
        title:   "Startup Time (s)",
	min:     0,
	max:     100,
        setting: "startuptime",
    });
   l.layout.push({
        type:    "integer",
        title:   "McIntosh USB Vendor ID (VID identifier)",
        setting: "usbVid",
    });
    return l;
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(mysettings));
    },
    save_settings: function(req, isdryrun, settings) {
	let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            var oldmode = mysettings.mode;
            var oldip = mysettings.ip;
            var oldport = mysettings.serialport;
            mysettings = l.values;
            svc_settings.update_settings(l);
            let force = false;
            if (oldmode != mysettings.mode) force = true;
            if (oldport != mysettings.serialport) force = true;
            if (force) setup();
            roon.save_config("settings", mysettings);
        }
    }
});

var svc_status = new RoonApiStatus(roon);
var svc_volume_control = new RoonApiVolumeControl(roon);
var svc_source_control = new RoonApiSourceControl(roon);

roon.init_services({
    provided_services: [ svc_volume_control, svc_source_control, svc_settings, svc_status ]
});

function setup() {
    if (mcintosh.control)
        mcintosh.control.stop();

    mcintosh.control = new McIntosh();

    mcintosh.control.on('connected', ev_connected);
    mcintosh.control.on('disconnected', ev_disconnected);
    mcintosh.control.on('volume', ev_volume);
    mcintosh.control.on('source', ev_source);

    if (mcintosh.source_control) { mcintosh.source_control.destroy(); delete(mcintosh.source_control); }
    if (mcintosh.volume_control) { mcintosh.volume_control.destroy(); delete(mcintosh.volume_control); }

    var opts = { volume: mysettings.initialvolume, source: mysettings.setsource, usbVid: mysettings.usbVid };
    if (!mysettings.serialport) {
        svc_status.set_status("Not configured, please check settings.", true);
        return;
    }
    opts.port = mysettings.serialport;
    console.log(opts);
    mcintosh.control.start(opts);
}

function ev_connected(status) {
    let control = mcintosh.control;

    console.log("[McIntosh Extension] Connected");

    svc_status.set_status("Connected to McIntosh", false);

    control.set_volume(mysettings.initialvolume);
    control.set_source(mysettings.setsource);

    mcintosh.volume_control = svc_volume_control.new_device({
	state: {
	    display_name: "McIntosh",
	    volume_type:  "number",
	    volume_min:   0,
	    volume_max:   100,
	    volume_value: control.properties.volume > 0 ? control.properties.volume : 10,
	    volume_step:  1.0,
	    is_muted:     control.properties.source == "Muted"
	},
	set_volume: function (req, mode, value) {
	    let newvol = mode == "absolute" ? value : (control.properties.volume + value);
	    if      (newvol < this.state.volume_min) newvol = this.state.volume_min;
	    else if (newvol > this.state.volume_max) newvol = this.state.volume_max;
	    control.set_volume(newvol);
	    req.send_complete("Success");
	},
	set_mute: function (req, mode) {
		if (mode == "on") {
			control.mute(1);
		}	
	    else if (mode == "off")
				control.mute(0);
	    req.send_complete("Success");
	}
    });

    mcintosh.source_control = svc_source_control.new_device({
	state: {
	    display_name:     "McIntosh",
	    supports_standby: true,
	    status:           control.properties.source == "Standby" ? "standby" : (control.properties.source == mysettings.setsource ? "selected" : "deselected")
	},
	convenience_switch: function (req) {
		if(this.state.status == "standby") {
			control.power_on();
			control.set_source(mysettings.setsource);
			setTimeout(() => {
				req.send_complete("Success");
			}, mysettings.startuptime * 1000);
			control.set_volume(mysettings.initialvolume);
		}
		else {
			control.set_source(mysettings.setsource);
			req.send_complete("Success");
		}
	},
	standby: function (req) {
	    this.state.status = "standby";
	    control.power_off();
	    req.send_complete("Success");
	}
    });

}

function ev_disconnected(status) {
    let control = mcintosh.control;

    console.log("[McIntosh Extension] Disconnected");

    svc_status.set_status("Could not connect to McIntosh on \"" + mysettings.serialport + "\"", true);

    if (mcintosh.source_control) { mcintosh.source_control.destroy(); delete(mcintosh.source_control); }
    if (mcintosh.volume_control) { mcintosh.volume_control.destroy(); delete(mcintosh.volume_control);   }
}

function ev_volume(val) {
    let control = mcintosh.control;
    console.log("[McIntosh Extension] received volume change from device:", val);
    if (mcintosh.volume_control)
        mcintosh.volume_control.update_state({ volume_value: val });
}
function ev_source(val) {
    let control = mcintosh.control;
    console.log("[McIntosh Extension] received source change from device:", val);
    if (val == "Muted" && mcintosh.volume_control)
        mcintosh.volume_control.update_state({ is_muted: true });
    else if (val == "UnMuted" && mcintosh.volume_control)
        mcintosh.volume_control.update_state({ is_muted: false });
    else if (val == "Standby" && mcintosh.source_control)
        mcintosh.source_control.update_state({ status: "standby" });
    else {
	if (mcintosh.volume_control)
	    mcintosh.volume_control.update_state({ is_muted: false });
	mcintosh.source_control.update_state({ status: (val == mysettings.setsource ? "selected" : "deselected") });
    }
}

setup();

roon.start_discovery();
