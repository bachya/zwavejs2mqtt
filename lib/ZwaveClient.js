'use strict'

var reqlib = require('app-root-path').require,
OpenZWave = require('openzwave-shared'),
utils = reqlib('/lib/utils.js'),
EventEmitter = require('events'),
fs = require('fs'),
jsonStore = reqlib('/lib/jsonStore.js'),
store = reqlib('config/store.js'),
inherits = require('util').inherits;

//Events to subscribe to
const EVENTS = {
  'driver ready': driverReady,
  'driver failed': driverFailed,
  'node added': nodeAdded,
  'node ready': nodeReady,
  'node event': nodeEvent,
  'scene event': sceneEvent,
  'value added': valueAdded,
  'value changed': valueChanged,
  'value removed': valueRemoved,
  'notification': notification,
  'scan complete': scanComplete,
  'controller command': controllerCommand
};

//Status based on notification
const NODE_STATUS = {
  3: "Awake",
  4: "Sleep",
  5: "Dead",
  6: "Alive"
}


/**
* The constructor
*/
function ZwaveClient (config, socket) {
  if (!(this instanceof ZwaveClient)) {
    return new ZwaveClient(config)
  }
  EventEmitter.call(this);
  init.call(this, config, socket);
}

inherits(ZwaveClient, EventEmitter);

function init(cfg, socket){

  this.cfg = cfg;
  this.socket = socket;

  this.closed = false;
  this.scenes = jsonStore.get(store.scenes);

  //Full option list: https://github.com/OpenZWave/open-zwave/wiki/Config-Options
  var client = new OpenZWave({
    Logging: cfg.logging,
    ConsoleOutput: cfg.logging,
    QueueLogLevel: cfg.logging ? 8 : 6,
    UserPath: utils.getPath(true), //where to store config files
    DriverMaxAttempts: 3,
    NetworkKey: cfg.networkKey || "",
    SaveConfiguration: cfg.saveConfig,
    //ConfigPath: , //where zwave devices database resides
    //PollInterval: 500,
    //SuppressValueRefresh: true,
  });

  this.nodes = [];
  this.devices = {};

  this.client = client;
  this.ozwConfig = {};

  var self = this;

  Object.keys(EVENTS).forEach(function(evt) {
    client.on(evt, EVENTS[evt].bind(self));
  });
}

function driverReady(homeid) {
  this.driverReadyStatus = true;
  this.ozwConfig.homeid = homeid;
  var homeHex = '0x' + homeid.toString(16);
  this.ozwConfig.name = homeHex;

  sendLog(this, 'Scanning network with homeid:', homeHex);

  //delete any previous existing config
  if(!this.cfg.saveConfig){
    fs.readdir(utils.getPath(true), (err, files) => {
      files.forEach(file => {
        file = file.split('/').pop();
        if(/zwcfg_[\w]+.xml/g.test(file) || file == 'zwscene.xml')
          fs.unlinkSync(file);
      });
    })
  }

}

function driverFailed() {
  sendLog(this, 'Driver failed', this.ozwConfig);
}

function nodeAdded(nodeid) {
  this.nodes[nodeid] = {
    node_id: nodeid,
    device_id: '',
    manufacturer: '',
    manufacturerid: '',
    product: '',
    producttype: '',
    productid: '',
    type: '',
    name: '',
    loc: '',
    values: {},
    groups: [],
    ready: false,
    status: NODE_STATUS[5] //dead
  };
  sendLog(this, "Node added", nodeid)
}

function valueAdded(nodeid, comclass, valueId) {
  var ozwnode = this.nodes[nodeid];
  if (!ozwnode) {
    sendLog(this, 'ValueAdded: no such node: '+nodeid, 'error');
  }

  sendLog(this, "ValueAdded", valueId.value_id);
  ozwnode.values[getValueID(valueId)] = valueId;
}

function valueChanged(nodeid, comclass, valueId) {
  var ozwnode = this.nodes[nodeid];
  var value_id = getValueID(valueId);
  if (!ozwnode) {
    sendLog(this, 'valueChanged: no such node: '+nodeid, 'error');
  } else {
    var oldst;
    if (ozwnode.ready) {
      oldst = ozwnode.values[value_id].value;
      sendLog(this, `zwave node ${nodeid}: changed: ${comclass}:${valueId.label}:${oldst} -> ${valueId.value}`);
      this.emit('valueChanged', valueId, ozwnode, value_id);
    }
    // update cache
    ozwnode.values[value_id] = valueId;
  }
}

function valueRemoved(nodeid, comclass, instance, index) {
  var ozwnode = this.nodes[nodeid];
  var value_id = getValueID({class_id: comclass, instance:instance, index:index});
  if (ozwnode.values[value_id]) {
      delete ozwnode.values[value_id];
    } else {
      sendLog(this, 'valueRemoved: no such node: '+nodeid, 'error');
    }
  }

  function nodeReady(nodeid, nodeinfo) {
    var ozwnode = this.nodes[nodeid];
    if (ozwnode) {

      for (var attrname in nodeinfo) {
        if (nodeinfo.hasOwnProperty(attrname)) {
          ozwnode[attrname] = nodeinfo[attrname];
        }
      }

      ozwnode.ready = true;
      ozwnode.status = NODE_STATUS[6];

      //enable poll
      for (var v in ozwnode.values) {
        var comclass = ozwnode.values[v].class_id;
          switch (comclass) {
            case 0x25: // COMMAND_CLASS_SWITCH_BINARY
            case 0x26: // COMMAND_CLASS_SWITCH_MULTILEVEL
            case 0x30: // COMMAND_CLASS_SENSOR_BINARY
            case 0x31: // COMMAND_CLASS_SENSOR_MULTILEVEL
            case 0x60: // COMMAND_CLASS_MULTI_INSTANCE
            if(!this.client.isPolled(ozwnode.values[v]))
              this.client.enablePoll(ozwnode.values[v], 0);
            break;
          }
      }

      var deviceID = getDeviceID(ozwnode);

      ozwnode.device_id = deviceID;

      for(var v in ozwnode.values){
        this.emit('valueChanged', ozwnode.values[v], ozwnode, v);
      }

      if(!this.devices[deviceID]){
        this.devices[deviceID] = {
          name: `${ozwnode.product} (${ozwnode.manufacturer})`,
          values: JSON.parse(JSON.stringify(ozwnode.values))
        };

        //remove node specific info from values
        for (var v in this.devices[deviceID].values) {
          var tmp = this.devices[deviceID].values[v];
          delete tmp.node_id;
          tmp.value_id = getValueID(tmp);
        }
      }

      this.emit('nodeStatus', ozwnode);

      sendLog(this, 'node ready', nodeid, nodeinfo);
    }
  }

  function nodeEvent(nodeid, evtcode) {
    sendLog(this, 'node event', nodeid, evtcode);
  }

  function sceneEvent(nodeid, scene) {
    sendLog(this, 'scene event', nodeid, scene);
  }

  function notification(nodeid, notif, help) {
    var msg = "";
    var ozwnode = this.nodes[nodeid];
    switch (notif) {
      case 0:
      msg = 'node'+ nodeid + ': message complete';
      break;
      case 1:
      msg = 'node'+ nodeid + ': timeout';
      break;
      case 2:
      msg = 'node'+ nodeid + ': nop';
      break;
      case 3: //awake
      case 4: //sleep
      case 5: //dead
      case 6: //alive
      msg = 'node'+ nodeid + ': node ' + NODE_STATUS[notif];
      ozwnode.status = NODE_STATUS[notif];
      ozwnode.ready = notif != 5;

      this.emit('nodeStatus', ozwnode);
      break;
      default:
      msg = "Unknown notification code " + notif
    }

    sendLog(this, 'notification', {
      nodeid: nodeid,
      notification: notif,
      help: help
    });
  }

  function scanComplete() {

    this.client.setPollInterval(this.cfg.pollInterval);

    //popolate groups
    for (var i = 0; i < this.nodes.length; i++) {
      if(this.nodes[i]){
        var numGrups = this.client.getNumGroups(i);
        for(var n = 0; n<numGrups;n++){
          var label = this.client.getGroupLabel(i, n+1);
          this.nodes[i].groups.push({text: label, value: n+1});
        }
      }
    }

    sendLog(this, 'Network scan complete. Found:', this.nodes.length, 'nodes');
  }

  function controllerCommand(nodeid, state, errcode, help) {
    var obj = {
      nodeid: nodeid,
      state: state,
      errcode: errcode,
      help: help
    };
    sendLog(this, 'controller command', obj);
  }

  //------- Utils ------------------------

  function getDeviceID(ozwnode){
    if(!ozwnode) return "";

    return `${parseInt(ozwnode.manufacturerid)}-${parseInt(ozwnode.productid)}-${parseInt(ozwnode.producttype)}`;
  }

  function getValueID(v){
    return `${v.class_id}-${v.instance}-${v.index}`;
  }

  /**
  * Function wrapping code used for writing queue.
  * fn - reference to function.
  * context - what you want "this" to be.
  * params - array of parameters to pass to function.
  */
  function wrapFunction(fn, context, params) {
    return function() {
      debugger;
      fn.apply(context, params);
    };
  }


  //-------- Public methods --------------

  /**
  * Method used to close client connection, use this before destroy
  */
  ZwaveClient.prototype.close = function () {
    if(this.connected && this.client){
      this.connected = false;
      this.client.disconnect(this.cfg.port);
    }
  }

  /**
  * Method used to close client connection, use this before destroy
  */
  ZwaveClient.prototype.connect = function () {
    if(!this.connected){
      sendLog(this, "Connecting to", this.cfg.port);
      this.client.connect(this.cfg.port);
      this.connected = true;
    }else{
      sendLog(this, "Client already connected to", this.cfg.port);
    }
  }

  /**
  * Method used to emit zwave events to the socket
  */
  ZwaveClient.prototype.emitEvent = function (evtName, data) {
    if(this.socket){
      this.socket.emit(evtName, data)
    }
  }


  //------------SCENES MANAGEMENT-----------------------------------

  /**
  * Create a new scene with a label
  */
  ZwaveClient.prototype.createScene = function (label) {
    var id = this.scenes.length > 0 ? this.scenes[this.scenes.length-1].sceneid + 1 : 1;
    this.scenes.push({sceneid: id, label: label, values: []});

    this.updateJSON();

    return true;
  }

  /**
  * Delete a scene
  */
  ZwaveClient.prototype.removeScene = function (sceneid) {
    var index = this.scenes.findIndex(s => s.sceneid == sceneid);

    if(index < 0) throw Error('No scene found with given sceneid');

    this.scenes.splice(index,1);

    this.updateJSON();

    return true;
  }

  /**
  * Update scenes (NOT A ZWAVE API)
  */
  ZwaveClient.prototype.setScenes = function (scenes) {
    // TODO: add scenes validation
    this.scenes = scenes;
    this.updateJSON();

    return scenes;
  }


  /**
  * Get all scenes
  */
  ZwaveClient.prototype.getScenes = function () {
    return this.scenes;
  }

  /**
  * Get scene values
  */
  ZwaveClient.prototype.sceneGetValues = function (sceneid) {
    var scene = this.scenes.find(s => s.sceneid == sceneid);
    if(!scene) throw Error('No scene found with given sceneid')
    return scene.values;
  }

  /**
  * Add a value to a scene
  * args can be [{valueid}, value, ?timeout] or
  * [node_id, class_id, instance, index, value, ?timeout]
  */
  ZwaveClient.prototype.addSceneValue = function (sceneid, ...args) {
    var valueId;
    var value;
    var timeout;
    var scene = this.scenes.find(s => s.sceneid == sceneid);

    if(!scene) throw Error('No scene found with given sceneid')

    if(typeof args[0] === 'object' && args.length >= 2) {
      valueId = args[0];
      value = args[1];
      timeout = args[2];
    }else if(args.length >= 5){
      valueId = {node_id: args[0], class_id: args[1], instance: args[2], index: args[3]};
      value = args[4];
      timeout = args[5];
    }else{
      throw Error('No valueId found in parameters')
    }

    if(this.nodes.length < valueId.node_id || !this.nodes[valueId.node_id]) throw Error('Node not found')
    else{

      //get the valueId object with all properties
      valueId = this.nodes[valueId.node_id].values[getValueID(valueId)];

      //check if it is an existing valueid
      if(!valueId) throw Error('No value found with given valueId')
      else{
        //if this valueid is already in owr scene edit it else create new one
        var index = scene.values.findIndex(s => s.value_id == valueId.value_id);

        valueId = index < 0 ? valueId : scene.values[index];
        valueId.value = value;
        valueId.timeout = timeout || 0;

        if(index < 0)
          scene.values.push(valueId);
      }
    }

    this.updateJSON();

    return true;
  }

  /**
  * Remove a value from a scene
  * args can be [{valueid}] or
  * [node_id, class_id, instance, index]
  */
  ZwaveClient.prototype.removeSceneValue = function (sceneid, ...args) {
    var valueId;
    var scene = this.scenes.find(s => s.sceneid == sceneid);

    if(!scene) throw Error('No scene found with given sceneid')

    if(args.length == 1) {
      valueId = args[0];
    }else if(args.length == 4){
      valueId = {node_id: args[0], class_id: args[1], instance: args[2], index: args[3]};
    }else{
      throw Error('No valueId found in parameters')
    }

    // here I don't fetch the valueId obj from nodes because
    // it's possible that the scene contains
    // a value of a node that doesn't exist anymore
    var id = valueId.node_id+'-'+getValueID(valueId);

    var index = scene.values.findIndex(s => s.value_id == id);

    if(index < 0) throw Error('No valueid match found in given scene')
    else{
      scene.values.splice(index,1)
    }

    this.updateJSON();

    return true;
  }

  /**
  * Activate a scene by its id (fix for activateScene not working properly)
  */
  ZwaveClient.prototype.activateScene = function (sceneId) {
    var values = this.sceneGetValues(sceneId);

    for (var i = 0; values && i < values.length; i++) {
      var fun = wrapFunction(this.client.setValue, this.client, [values[i], values[i].value]);
      setTimeout(fun, values[i].timeout ? values[i].timeout*1000 : 0);
    }

    return true;
  }

  /**
  * Update scenes json file
  */
  ZwaveClient.prototype.updateJSON = function () {
    var self = this;
    jsonStore.put(store.scenes, this.scenes)
    .catch(err => {
      sendLog(self, err)
    })
  }

  /**
  * Method used to close call an API of zwave client
  */
  ZwaveClient.prototype.callApi = function (apiName, ...args) {
    var err, result;

    if(this.connected){
      if(typeof this.client[apiName] === 'function' || apiName == 'setScenes'){
        try {
          //custom scenes management
          var updateStore = false;

          //use the custom scene management system
          if(apiName.toLowerCase().includes('scene'))
            result = this[apiName](...args)
          else
            result = this.client[apiName](...args);

        } catch (e) {
          err = e.message;
        }
      }
      else err = "Unknown API";

    }else err = "Zwave client not connected";

    if(err){
      result = {success: false, message: err}
    }else{
      result = {success: true, message: "Success zwave api call", result: result}
    }

    sendLog(this, result.message, apiName, result.result || "")

    return result;
  }

  /**
  * Method used to write a value to zwave network
  */
  ZwaveClient.prototype.writeValue = function (valueId, value) {
    if(this.connected){
      this.client.setValue(valueId, value);
    }
  }

  /**
  * Method used to send a broadcast value to all devices of a specific type
  */
  ZwaveClient.prototype.writeBroadcast = function (valueId, deviceID, value) {
    if(this.connected){
      var devices = [];

      for (var i = 0; i < this.nodes.length; i++) {
        if(this.nodes[i] && this.nodes[i].device_id == deviceID)
          devices.push(i)
      }

      for (var i = 0; i < devices.length; i++)
        this.client.setValue(devices[i], valueId.class_id, valueId.instance, valueId.index, value);
    }
  }


  function sendLog(self, ...args){
    console.log(`Zwave`, ...args);
  }


  module.exports = ZwaveClient;