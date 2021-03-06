'use strict';

function _toConsumableArray(arr) {
  if (Array.isArray(arr)) {
    for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
      arr2[i] = arr[i];
    }
    return arr2;
  } else {
    return Array.from(arr);
  }
}

var request = require('request');
var geocoder = require('geocoder');
var events = require('events');
var ProtoBuf = require('protobufjs');
var GoogleOAuth = require('gpsoauthnode');
var fs = require('fs');
var S2 = require('s2-geometry').S2;

var Logins = require('./logins');

var builder = ProtoBuf.loadProtoFile('pokemon.proto');
if (builder === null) {
  builder = ProtoBuf.loadProtoFile(__dirname + '/pokemon.proto');
}

var pokemonProto = builder.build();

var RequestEnvelop = pokemonProto.RequestEnvelop;
var ResponseEnvelop = pokemonProto.ResponseEnvelop;
var pokemonlist = JSON.parse(fs.readFileSync(__dirname + '/pokemons.json', 'utf8'));

var EventEmitter = events.EventEmitter;

var api_url = 'https://pgorelease.nianticlabs.com/plfe/rpc';

function GetCoords(self) {
  var _self$playerInfo = self.playerInfo;
  var latitude = _self$playerInfo.latitude;
  var longitude = _self$playerInfo.longitude;

  return [latitude, longitude];
}

function getNeighbors(lat, lng) {
  var level = 15;
  var origin = S2.latLngToQuadkey(lat, lng, level);
  var walk = [S2.toId(origin)];
  // 10 before and 10 after
  var next = S2.nextKey(origin);
  var prev = S2.prevKey(origin);
  for (var i = 0; i < 10; i++) {
    // in range(10):
    walk.push(S2.toId(prev));
    walk.push(S2.toId(next));
    next = S2.nextKey(next);
    prev = S2.prevKey(prev);
  }
  return walk;
}

function Pokeio() {
  var self = this;
  self.events = new EventEmitter();
  self.j = request.jar();
  self.request = request.defaults({
    jar: self.j
  });

  self.google = new GoogleOAuth();

  self.pokemonlist = pokemonlist.pokemon;

  self.playerInfo = {
    accessToken: '',
    debug: true,
    latitude: 0,
    longitude: 0,
    altitude: 0,
    locationName: '',
    provider: '',
    apiEndpoint: ''
  };

  self.DebugPrint = function (str) {
    if (self.playerInfo.debug === true) {
      //self.events.emit('debug',str)
      console.log(str);
    }
  };

  function api_req(api_endpoint, access_token, req, callback) {
    // Auth
    var auth = new RequestEnvelop.AuthInfo({
      provider: self.playerInfo.provider,
      token: new RequestEnvelop.AuthInfo.JWT(access_token, 59)
    });

    var f_req = new RequestEnvelop({
      unknown1: 2,
      rpc_id: 1469378659230941192,

      requests: req,

      latitude: self.playerInfo.latitude,
      longitude: self.playerInfo.longitude,
      altitude: self.playerInfo.altitude,

      auth: auth,
      unknown12: 989
    });

    var protobuf = f_req.encode().toBuffer();

    var options = {
      url: api_endpoint,
      body: protobuf,
      encoding: null,
      headers: {
        'User-Agent': 'Niantic App'
      }
    };

    self.request.post(options, function (err, response, body) {
      if (err) {
        return callback(new Error('Error'));
      }

      if (response === undefined || body === undefined) {
        console.error('[!] RPC Server offline');
        return callback(new Error('RPC Server offline'));
      }

      var f_ret;
      try {
        f_ret = ResponseEnvelop.decode(body);
      } catch (e) {
        if (e.decoded) {
          // Truncated
          console.warn(e);
          f_ret = e.decoded; // Decoded message with missing required fields
        }
      }

      if (f_ret) {
        return callback(null, f_ret);
      } else {
        api_req(api_endpoint, access_token, req, callback);
      }
    });
  }

  self.init = function (username, password, location, provider, callback) {
    if (provider !== 'ptc' && provider !== 'google') {
      return callback(new Error('Invalid provider'));
    }
    // set provider
    self.playerInfo.provider = provider;
    // Updating location
    self.SetLocation(location, function (err, loc) {
      if (err) {
        return callback(err);
      }
      // Getting access token
      self.GetAccessToken(username, password, function (err, token) {
        if (err) {
          return callback(err);
        }
        // Getting api endpoint
        self.GetApiEndpoint(function (err, api_endpoint) {
          if (err) {
            return callback(err);
          }
          callback(null);
        });
      });
    });
  };

  self.GetAccessToken = function (user, pass, callback) {
    self.DebugPrint('[i] Logging with user: ' + user);
    if (self.playerInfo.provider === 'ptc') {
      Logins.PokemonClub(user, pass, self, function (err, token) {
        if (err) {
          return callback(err);
        }

        self.playerInfo.accessToken = token;
        self.DebugPrint('[i] Received PTC access token!');
        callback(null, token);
      });
    } else {
      Logins.GoogleAccount(user, pass, self, function (err, token) {
        if (err) {
          return callback(err);
        }

        self.playerInfo.accessToken = token;
        self.DebugPrint('[i] Received Google access token!');
        callback(null, token);
      });
    }
  };

  self.GetApiEndpoint = function (callback) {
    var req = [new RequestEnvelop.Requests(2), new RequestEnvelop.Requests(126), new RequestEnvelop.Requests(4), new RequestEnvelop.Requests(129), new RequestEnvelop.Requests(5)];

    api_req(api_url, self.playerInfo.accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      }
      var api_endpoint = 'https://' + f_ret.api_url + '/rpc';
      self.playerInfo.apiEndpoint = api_endpoint;
      self.DebugPrint('[i] Received API Endpoint: ' + api_endpoint);
      return callback(null, api_endpoint);
    });
  };

  self.GetInventory = function (callback) {
    var req = new RequestEnvelop.Requests(4);

    api_req(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      }
      var dErr, inventory;
      try {
        inventory = ResponseEnvelop.GetInventoryResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, inventory);
    });
  };

  self.GetProfile = function (callback) {
    var req = new RequestEnvelop.Requests(2);
    api_req(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.ProfilePayload.decode(f_ret.payload[0]).profile;
      } catch (err) {
        dErr = err;
      }

      callback(dErr, response);

      if (response)
        if (response.username) {
          self.DebugPrint('[i] Logged in!');
        }

    });
  };

  // IN DEVELPOMENT, YES WE KNOW IS NOT WORKING ATM
  self.Heartbeat = function (callback) {
    var _self$playerInfo2 = self.playerInfo;
    var apiEndpoint = _self$playerInfo2.apiEndpoint;
    var accessToken = _self$playerInfo2.accessToken;


    var nullbytes = new Array(21);
    nullbytes.fill(0);

    // Generating walk data using s2 geometry
    var walk = getNeighbors(self.playerInfo.latitude, self.playerInfo.longitude).sort(function (a, b) {
      return a > b;
    });

    // Creating MessageQuad for Requests type=106
    var walkData = new RequestEnvelop.MessageQuad({
      'f1': walk,
      'f2': nullbytes,
      'lat': self.playerInfo.latitude,
      'long': self.playerInfo.longitude
    });

    var req = [new RequestEnvelop.Requests(106, walkData.encode().toBuffer()), new RequestEnvelop.Requests(126), new RequestEnvelop.Requests(4, new RequestEnvelop.Unknown3(Date.now().toString()).encode().toBuffer()), new RequestEnvelop.Requests(129), new RequestEnvelop.Requests(5, new RequestEnvelop.Unknown3('05daf51635c82611d1aac95c0b051d3ec088a930').encode().toBuffer())];

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, heartbeat;
      try {
        heartbeat = ResponseEnvelop.HeartbeatPayload.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, heartbeat);

    });
  };

  self.GetLocation = function (callback) {
    geocoder.reverseGeocode.apply(geocoder, _toConsumableArray(GetCoords(self)).concat([function (err, data) {
      if (data.status === 'ZERO_RESULTS') {
        return callback(new Error('location not found'));
      }

      callback(null, data.results[0].formatted_address);
        }]));
  };

  // Still WIP
  self.GetFortDetails = function (fortid, fortlat, fortlong, callback) {
    var fortDetailsMessage = new RequestEnvelop.FortDetailsRequest({
      'fort_id': fortid,
      'fort_latitude': fortlat,
      'fort_longitude': fortlong
    });

    var req = new RequestEnvelop.Requests(104, fortDetailsMessage.encode().toBuffer());

    api_req(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.FortDetailsResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);
    });
  };

  // Still WIP
  self.GetFort = function (fortid, fortlat, fortlong, callback) {
    var fortSearchMessage = new RequestEnvelop.FortSearchMessage({
      'fort_id': fortid,
      'player_latitude': self.playerInfo.latitude,
      'player_longitude': self.playerInfo.longitude,
      'fort_latitude': fortlat,
      'fort_longitude': fortlong
    });

    var req = new RequestEnvelop.Requests(101, fortSearchMessage.encode().toBuffer());

    api_req(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.FortSearchResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);
    });
  };

  self.EvolvePokemon = function (pokemonId, callback) {
    var _self$playerInfo3 = self.playerInfo;
    var apiEndpoint = _self$playerInfo3.apiEndpoint;
    var accessToken = _self$playerInfo3.accessToken;

    var evolvePokemon = new RequestEnvelop.EvolvePokemonMessage({
      'PokemonId': pokemonId
    });

    var req = new RequestEnvelop.Requests(125, evolvePokemon.encode().toBuffer());

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.EvolvePokemonResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);
    });
  };

  self.TransferPokemon = function (pokemonId, callback) {
    var _self$playerInfo3 = self.playerInfo;
    var apiEndpoint = _self$playerInfo3.apiEndpoint;
    var accessToken = _self$playerInfo3.accessToken;

    var transferPokemon = new RequestEnvelop.TransferPokemonMessage({
      'PokemonId': pokemonId
    });

    var req = new RequestEnvelop.Requests(112, transferPokemon.encode().toBuffer());

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.TransferPokemonResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);
    });
  };

  //still WIP
  self.CatchPokemon = function (mapPokemon, normalizedHitPosition, normalizedReticleSize, spinModifier, pokeball, callback) {
    var _self$playerInfo3 = self.playerInfo;
    var apiEndpoint = _self$playerInfo3.apiEndpoint;
    var accessToken = _self$playerInfo3.accessToken;

    var catchPokemon = new RequestEnvelop.CatchPokemonMessage({
      'encounter_id': mapPokemon.EncounterId,
      'pokeball': pokeball,
      'normalized_reticle_size': normalizedReticleSize,
      'spawnpoint_id': mapPokemon.SpawnPointId,
      'hit_pokemon': true,
      'spin_modifier': spinModifier,
      'normalized_hit_position': normalizedHitPosition
    });

    var req = new RequestEnvelop.Requests(103, catchPokemon.encode().toBuffer());

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.CatchPokemonResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);

    });
  };

  self.EncounterPokemon = function (catchablePokemon, callback) {
    var _self$playerInfo4 = self.playerInfo;
    var apiEndpoint = _self$playerInfo4.apiEndpoint;
    var accessToken = _self$playerInfo4.accessToken;
    var latitude = _self$playerInfo4.latitude;
    var longitude = _self$playerInfo4.longitude;

    var encounterPokemon = new RequestEnvelop.EncounterMessage({
      'encounter_id': catchablePokemon.EncounterId,
      'spawnpoint_id': catchablePokemon.SpawnPointId,
      'player_latitude': latitude,
      'player_longitude': longitude
    });

    var req = new RequestEnvelop.Requests(102, encounterPokemon.encode().toBuffer());

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.EncounterResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);

    });
  };

  self.DropItem = function (itemId, count, callback) {
    var _self$playerInfo4 = self.playerInfo;
    var apiEndpoint = _self$playerInfo4.apiEndpoint;
    var accessToken = _self$playerInfo4.accessToken;
    var latitude = _self$playerInfo4.latitude;
    var longitude = _self$playerInfo4.longitude;

    var dropItemMessage = new RequestEnvelop.RecycleInventoryItemMessage({
      'item_id': itemId,
      'count': count
    });

    var req = new RequestEnvelop.Requests(137, dropItemMessage.encode().toBuffer());

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.RecycleInventoryItemResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);

    });
  };


  self.ReleasePokemon = function (pokemon, callback) {
    console.log(pokemon.toString());
    var releasePokemon = new RequestEnvelop.ReleasePokemonMessage({
      'pokemon_id': pokemon.toString()
    });
    var req = new RequestEnvelop.Requests(112, releasePokemon.encode().toBuffer());

    var _self$playerInfo3 = self.playerInfo;
    var apiEndpoint = _self$playerInfo3.apiEndpoint;
    var accessToken = _self$playerInfo3.accessToken;

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.ReleasePokemonResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);
    });

  };

  self.LevelUpRewards = function (level, callback) {

    var levelUpRewards = new RequestEnvelop.LevelUpRewardsMessage({
      'level': level
    });
    var req = new RequestEnvelop.Requests(128, levelUpRewards.encode().toBuffer());

    var _self$playerInfo3 = self.playerInfo;
    var apiEndpoint = _self$playerInfo3.apiEndpoint;
    var accessToken = _self$playerInfo3.accessToken;

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.LevelUpRewardsResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);
    });

  };

  self.UseItemEggIncubator = function (item_id, pokemonId, callback) {

    var levelUpRewards = new RequestEnvelop.UseItemEggIncubatorMessage({
      'item_id': item_id,
      'pokemonId': pokemonId
    });
    var req = new RequestEnvelop.Requests(140, levelUpRewards.encode().toBuffer());

    var _self$playerInfo3 = self.playerInfo;
    var apiEndpoint = _self$playerInfo3.apiEndpoint;
    var accessToken = _self$playerInfo3.accessToken;

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.UseItemEggIncubatorResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);
    });

  };


  self.GetHatchedEggs = function (callback) {

    var req = new RequestEnvelop.Requests(140);

    var _self$playerInfo3 = self.playerInfo;
    var apiEndpoint = _self$playerInfo3.apiEndpoint;
    var accessToken = _self$playerInfo3.accessToken;

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }

      var dErr, response;
      try {
        response = ResponseEnvelop.GetHatchedEggsResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);
    });

  };

  self.UseItemXpBoost = function (itemId, count, callback) {

    var useItemXpBoostMessage = new RequestEnvelop.UseItemXpBoostMessage({
      'item_id': itemId,
    });

    var req = new RequestEnvelop.Requests(139, useItemXpBoostMessage.encode().toBuffer());

    var _self$playerInfo3 = self.playerInfo;
    var apiEndpoint = _self$playerInfo3.apiEndpoint;
    var accessToken = _self$playerInfo3.accessToken;

    api_req(apiEndpoint, accessToken, req, function (err, f_ret) {

      if (err) {
        return callback(err);
      } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
        return callback('No result');
      }
      var dErr, response;
      try {
        response = ResponseEnvelop.UseItemXpBoostResponse.decode(f_ret.payload[0]);
      } catch (err) {
        dErr = err;
      }
      callback(dErr, response);
    });
  };

  self.GetLocationCoords = function () {
    var _self$playerInfo5 = self.playerInfo;
    var latitude = _self$playerInfo5.latitude;
    var longitude = _self$playerInfo5.longitude;
    var altitude = _self$playerInfo5.altitude;

    return {
      latitude: latitude,
      longitude: longitude,
      altitude: altitude
    };
  };

  self.SetLocation = function (location, callback) {
    if (location.type !== 'name' && location.type !== 'coords') {
      return callback(new Error('Invalid location type'));
    }

    if (location.type === 'name') {
      if (!location.name) {
        return callback(new Error('You should add a location name'));
      }
      var locationName = location.name;
      geocoder.geocode(locationName, function (err, data) {
        if (err || data.status === 'ZERO_RESULTS') {
          return callback(new Error('location not found'));
        }

        var _data$results$0$geome = data.results[0].geometry.location;
        var lat = _data$results$0$geome.lat;
        var lng = _data$results$0$geome.lng;


        self.playerInfo.latitude = lat;
        self.playerInfo.longitude = lng;
        self.playerInfo.locationName = locationName;

        callback(null, self.GetLocationCoords());
      });
    } else if (location.type === 'coords') {
      if (!location.coords) {
        return callback(new Error('Coords object missing'));
      }

      self.playerInfo.latitude = location.coords.latitude || self.playerInfo.latitude;
      self.playerInfo.longitude = location.coords.longitude || self.playerInfo.longitude;
      self.playerInfo.altitude = location.coords.altitude || self.playerInfo.altitude;

      geocoder.reverseGeocode.apply(geocoder, _toConsumableArray(GetCoords(self)).concat([function (err, data) {
        if (err) return callback(err);
        if (data && data.status !== 'ZERO_RESULTS' && data.results && data.results[0]) {
          self.playerInfo.locationName = data.results[0].formatted_address;
        }

        callback(null, self.GetLocationCoords());
      }]));
    }
  };
}

Pokeio.prototype.toJSON = Pokeio.prototype.serialize = function () {
    var self = this;
    var json = {
      username: self.playerInfo.username
    , password: self.playerInfo.password
    , provider: self.playerInfo.provider

    , latitude: self.playerInfo.latitude
    , longitude: self.playerInfo.longitude
    , altitude: self.playerInfo.altitude

      // refresh before expires
    , accessToken: self.playerInfo.accessToken
    , accessTokenExpires: self.playerInfo.accessTokenExpires
    , apiEndpoint: self.playerInfo.apiEndpoint
    };
    return json;
};
module.exports.serialize = Pokeio.serialize = function (pokeio) {
    return pokeio.toJSON();
};

Pokeio.prototype.fromJSON = Pokeio.prototype.deserialize = function (opts) {
    var self = this;
    self.playerInfo.username = opts.username || 'johndoe';
    self.playerInfo.password = opts.password || 'secret';
    self.playerInfo.provider = opts.provider || 'ptc';
    self.playerInfo.accessToken = opts.accessToken || 'xyz';
    self.playerInfo.accessTokenExpires = opts.accessTokenExpires || 0;
    self.playerInfo.latitude = opts.latitude || 40.36915523640919;
    self.playerInfo.longitude = opts.longitude || -111.75098587678943;
    self.playerInfo.altitude = opts.altitude || 0;

    // TODO
    // logging reveals that cookies are probably not even used, just JWTs :)
    //self.j = request.jar(new FileCookieStore(path.resolve('/tmp/', self.playerInfo.username + '.pokemongo.json')));
    //self.request = request.defaults({ jar: self.j });

    self.playerInfo.apiEndpoint = opts.apiEndpoint;
};

module.exports.deserialize = Pokeio.deserialize = function (opts) {
    var pokeio = new Pokeio();
    pokeio.fromJSON(opts);
    return pokeio;
};

module.exports = new Pokeio();
module.exports.Pokeio = Pokeio;
