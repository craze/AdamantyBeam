var express = require('express');
var session = require('express-session');
var bodyparser = require('body-parser');
var socketio = require('socket.io');
var hbs = require('hbs');
var http = require('http');
var events = require('events').EventEmitter;
var util = require('util');
var log = require('log4js').getLogger('WEB');

module.exports = web = function(config, db, services, modules) {
	events.call(this);
	
	var app = express();
	app.set('db', db);
	app.set('modules', modules);
	app.set('view engine', 'html');
	app.engine('html', hbs.__express);
	
	app.use(express.static('public'));
	app.use(bodyparser.urlencoded({ extended: false }));
	
	var ses = session({
		secret: config.general.secret,
		saveUninitialized: true,
		resave: false
	});
	app.use(ses);
	
	var server = http.Server(app).listen(8080);
	var io = socketio(server);
	io.use(function(c, next) {
		ses(c.request, c.request.res, next);
	});
	io.on('connection', function(c) {
		if (!('userid' in c.request.session)) {
			return c.disconnect(); // Noooope.
		}
		
		c.on('service', function(data, cb) {
			if ('type' in data) {
				app.get('db').collection('services').find({ user: c.request.session.userid, type: data.type }).toArray(function(err, rows) {
					if (!err && rows.length > 0) {
						c.service = rows[0];
						cb();
					}
				});
			}
		});
		
		c.on('modulestate', function(data, cb) {
			if ('id' in data && 'state' in data && data.id in modules) {
				var id = c.service._id;
				var m = modules[data.id];
				var params = { service: id, module: m.id };
				app.get('db').collection('modules').update(params, { service: id, module: m.id, enabled: data.state === true }, { upsert: true }, function(err) {
					if (err) {
						return log.warn(err);
					}
					
					app.get('db').collection('modules').find(params).toArray(function(err, rows) {
						if (err) {
							throw err;
						}
						
						if (id in services) {
							var service = services[id];
							if (data.state) {
								m.enable(service, rows[0].config || {});
							}else{
								m.disable(service, rows[0].config || {});
							}
						}
						
						cb();
					});
				});
			}
		});
		
		c.on('getconfig', function(data, cb) {
			if ('id' in data && data.id in modules && c.service._id in services) {
				var m = modules[data.id];
				if ('config' in m) {
					app.get('db').collection('modules').find({ service: c.service._id, module: modules[data.id].id }).toArray(function(err, rows) {
						if (err) {
							return log.warn(err);
						}
						
						m.config(services[c.service._id], function(config) {
							cb(config, rows[0].config || {});
						});
					});
				}else{
					cb();
				}
			}
		});
		
		c.on('setconfig', function(data, cb) {
			if ('id' in data && 'config' in data && data.id in modules && c.service._id in services) {
				var m = modules[data.id];
				app.get('db').collection('modules').update({ service: c.service._id, module: m.id }, { service: c.service._id, module: m.id, config: data.config }, function(err) {
					if (err) {
						return log.warn(err);
					}
					
					var service = services[c.service._id];
					m.disable(service);
					m.enable(service, data.config);
					cb();
				});
			}
		});
		
		c.on('addconfig', function(data, cb) {
			if ('id' in data && data.id in modules && c.service._id in services && 'add' in modules[data.id]) {
				modules[data.id].add(services[c.service._id], db, data, cb);
			}
		});
		
		c.on('removeconfig', function(data, cb) {
			if ('id' in data && data.id in modules && c.service._id in services && 'remove' in modules[data.id]) {
				modules[data.id].remove(services[c.service._id], db, data, cb);
			}
		});
	});
	
	this.on('chat', function(data) {
		io.sockets.sockets.forEach(function(c) {
			if ('service' in c && c.service.type == data.service) {
				c.emit('chat', data);
			}
		});
	});
	
	require('./auth')(app);
	require('./manage')(app);
};

util.inherits(web, events);