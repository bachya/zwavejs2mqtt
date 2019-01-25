'use strict'

var reqlib = require('app-root-path').require,
    mqtt = require('mqtt'),
    utils = reqlib('/lib/utils.js'),
    NeDBStore = reqlib('/lib/Store.js'),
    EventEmitter = require('events'),
    storeDir = reqlib('config/app.js').storeDir,
    inherits = require('util').inherits;

    const CLIENTS_PREFIX = '_CLIENTS';
    const DEVICES_PREFIX = '$devices';

    const BROADCAST_PREFIX = '_BROADCAST';

    const NAME_PREFIX = "ZWAVE_GATEWAY-";

    var ACTIONS = ['broadcast', 'api'];

/**
 * The constructor
 */
function MqttClient (config) {
  if (!(this instanceof MqttClient)) {
    return new MqttClient(config)
  }
  EventEmitter.call(this);
  init.call(this, config);
}

inherits(MqttClient, EventEmitter);

function init(config){

  this.config = config;
  this.toSubscribe = [];

  this.clientID = this.cleanName(NAME_PREFIX + config.name);

  var options = {
    clientId: this.clientID,
    reconnectPeriod: config.reconnectPeriod,
    clean: config.clean,
    servers: [{ host: config.host, port: config.port }],
    will: {
      topic: this.getClientTopic(),
      payload: JSON.stringify({value: false}),
      qos: 1,
      retain: true
    }
  };

  if(config.store){
    var manager = NeDBStore(utils.joinPath(utils.getPath(true), storeDir, 'mqtt'), {compactionInterval: 30000});
    options.incomingStore = manager.incoming;
    options.outgoingStore = manager.outgoing;
  }

  if(config.auth){
    options.username = config.username;
    options.password = config.password;
  }

  try {
    var client  = mqtt.connect(options);

    this.client = client;

    client.on('connect', onConnect.bind(this));
    client.on('message', onMessageReceived.bind(this));
    client.on('reconnect', onReconnect.bind(this));
    client.on('close', onClose.bind(this));
    client.on('error', onError.bind(this));
    client.on('offline', onOffline.bind(this));

  } catch (e) {
    sendLog(self, 'Error while connecting MQTT', e.message);
    this.error = e.message;
  }
}

/**
 * Function called when MQTT client connects
 */
function onConnect() {
  sendLog(this, "MQTT client connected");
  this.emit('connect');

  if(this.toSubscribe){
    for (var i = 0; i < this.toSubscribe.length; i++) {
      this.subscribe(this.toSubscribe[i]);
    }
  }

  //subscribe to actions
  for (var i = 0; i < ACTIONS.length; i++) {
    this.client.subscribe([this.config.prefix, CLIENTS_PREFIX, this.clientID, ACTIONS[i], '#'].join('/'))
  }

  //Update client status
  this.updateClientStatus(true);

  this.toSubscribe = [];
}

/**
 * Function called when MQTT client reconnects
 */
function onReconnect() {
  sendLog(this, "MQTT client reconnecting");
}

/**
 * Function called when MQTT client reconnects
 */
function onError(error) {
  sendLog(this, error.message);
  this.error = error.message;
}

/**
 * Function called when MQTT client go offline
 */
function onOffline() {
  sendLog(this, "MQTT client offline");
}

/**
 * Function called when MQTT client is closed
 */
function onClose() {
  sendLog(this, "MQTT client closed");
}

/**
 * Function called when an MQTT message is received
 */
function onMessageReceived(topic, payload) {

  sendLog(this, "Message received on", topic);

  //remove prefix
  topic = topic.substring(this.config.prefix.length + 1);

  var parts = topic.split('/');

  //It's not a write request
  if(parts.pop() != 'set') return;

  if(this.closed) return;

  if(isNaN(payload)){
    try {
      payload = JSON.parse(payload);
    } catch(e) {
      payload = payload.toString();
    }
  }else payload = Number(payload);

  //It's an action
  if(parts[0] == CLIENTS_PREFIX){

    if(parts.length < 3 ) return;

    var action = ACTIONS.indexOf(parts[2]);

    switch (action) {
      case 0: //broadcast
        this.emit('broadcastRequest', parts.slice(3), payload);
        // publish back to give a feedback the action is received
        // same topic without /set suffix
        this.publish(parts.join('/'), payload);
      break;
      case 1: //api
        this.emit('apiCall', parts.join('/'), parts[3], payload);
      break;
      default:
        sendLog(this, "Unknown action received", action, topic);
    }

  }else{ // It's a write request on zwave network
    this.emit('writeRequest', parts, payload);
  }

}// end onMessageReceived

/**
 * Returns the topic used to send client and devices status updateStates
 * if name is null the client is the gateway itself
 */
MqttClient.prototype.getClientTopic = function(...devices){
  var subTopic = "";
  if(devices){
    for (var i = 0; i < devices.length; i++) {
      var name = this.cleanName(devices[i]);
      subTopic += '/'+DEVICES_PREFIX+'/' + name;
    }
  }

  return this.config.prefix + "/" + CLIENTS_PREFIX + "/" + this.clientID + subTopic + "/status";
}

MqttClient.prototype.cleanName = function(name){
  name = name.replace(/\s/g, '_');
  return name.replace(/[\+\*\#\\.''``!?^=(),""%[\]:;{}]+/g, '')
}

/**
 * Method used to close clients connection, use this before destroy
 */
MqttClient.prototype.close = function () {
  this.closed = true;

  if(this.client)
    this.client.end();
}

/**
 * Method used to get status
 */
MqttClient.prototype.getStatus = function () {
  var status = {};

  status.status = this.client && this.client.connected;
  status.error = this.error || 'Offline';
  status.config = this.config;

  return status;
}

/**
 * Method used to update client connection status
 */
MqttClient.prototype.updateClientStatus = function (connected, ...devices) {
  this.client.publish(this.getClientTopic(...devices), JSON.stringify({value:connected, time: Date.now()}),{retain:true,qos:1});
}

/**
 * Method used to update client
 */
MqttClient.prototype.update = function (config) {

  this.close();

  sendLog(this, `Restarting Mqtt Client after update...`);

  init.call(this, config);
}

/**
 * Method used to subscribe tags for write requests
 */
MqttClient.prototype.subscribe = function (topic) {
  if(this.client && this.client.connected){
    topic = this.config.prefix + '/' + topic + "/set";
    this.client.subscribe(topic);
  }
  else
    this.toSubscribe.push(topic);
}

/**
 * Method used to publish an update
 */
MqttClient.prototype.publish = function (topic, data) {

  if(this.client){

    var self = this;

    var options = {
      qos: this.config.qos,
      retain: this.config.retain
    };

    var topic = this.config.prefix + '/' + topic;

    this.client.publish(topic, JSON.stringify(data), options, function(err){
      if(err)
      sendLog(self, "Error while publishing a value", err.message);
    });

  } //end if client
}

/**
 * Used to get client connection status
 */
Object.defineProperty(MqttClient.prototype, 'connected', {
  get: function () {
    return this.client && this.client.connected;
  },
  enumerable: true
})

/**
 * The prefix to add to broadcast values
 */
Object.defineProperty(MqttClient.prototype, 'broadcastPrefix', {
  get: function () {
    return BROADCAST_PREFIX;
  },
  enumerable: true
})


function sendLog(self, ...args){
  console.log(`MQTT:`, ...args);
}

module.exports = MqttClient