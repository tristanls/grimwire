var http = require('http');
var pg = require('pg');
var express = require('express');
var stations_server = require('./signal_server.js');


// Server State
// ============
var server = express();
server.pgClient = new pg.Client("postgres://pfraze:password@localhost:5433/grimwire");
stations_server.pgClient = server.pgClient;
server.assets = {
	dashboardHtml: require('fs').readFileSync('./static/dashboard.html').toString()
};

// Common Handlers
// ===============
server.use(express.bodyParser());
server.use(express.cookieParser());
server.use(express.cookieSession({ secret: 'TODO -- INSERT SECRET TOKEN HERE' }));
server.all('*', setCorsHeaders);
server.options('*', function(request, response) {
	response.writeHead(204);
	response.end();
});


// Root
server.all('/', function(request, response, next) {
	response.setHeader('link', [
		'<http://grimwire.net:8000/>; rel="self service via grimwire.com/-webprn/service"; title="Grimwire.net WebPRN"',
		'<http://grimwire.net:8000/s>; rel="collection grimwire.com/-webprn/relays"; id="stations"',
		'<http://grimwire.net:8000/session>; rel="service"; id="session"',
		'<http://grimwire.net:8000/status>; rel="service"; id="status"'
	].join(', '));
	if (request.method == 'HEAD') {
		return response.send(204);
	}
	if (request.method == 'GET') {
		return response.format({
			'text/html': function() { response.send(server.assets.dashboardHtml); },
			'application/json': function() { response.json({ msg: 'hello' }); }
		});
	}
	ERRbadmethod(request, response);
});
// Matching static files
server.use('/', express.static(__dirname + '/static'));
// Stations Service
server.use('/s', stations_server);


// Admin
// =====
server.get('/status', function(request, response) {
	response.setHeader('link', [
		'<http://grimwire.net:8000/>; rel="up service via grimwire.com/-webprn/service"; title="Grimwire.net WebPRN"',
		'<http://grimwire.net:8000/status>; rel="self service"; id="status"'
	].join(', '));
	var uptime = (new Date() - server.startTime);
	response.json({
		started_at: server.startTime.toLocaleString(),
		uptime_seconds: uptime/1000,
		uptime_minutes: uptime/(60*1000),
		uptime_hours: uptime/(60*60*1000),
		uptime_days: uptime/(24*60*60*1000)
	});
});


// Session
// =======
server.all('/session',
	function (req, res, next) {
		getSession(req.session, function(err, session) {
			if (err) {
				return ERRinternal(req, res, 'Failed to get session info from DB', err);
			}
			res.locals.session = session;
			next();
		});
	},
	function (req, res, next) {
		// Set links
		res.setHeader('link', [
			'<http://grimwire.net:8000/>; rel="up service via grimwire.com/-webprn/service"; title="Grimwire.net WebPRN"',
			'<http://grimwire.net:8000/session>; rel="self service"; id="session"'
		].join(', '));

		// Route methods
		if (req.method == 'HEAD') {
			return res.send(204);
		}
		if (req.method == 'GET') {
			// Whoami?
			if (!req.accepts('json')) {
				return ERRbadaccept(req, res);
			}
			return res.json(res.locals.session);
		}
		if (req.method == 'POST') {
			// Sign In
			// Validate inputs
			var errors = validateSessionCreate(req.body);
			if (errors) {
				res.writeHead(422, 'bad entity', { 'content-type': 'application/json' });
				res.end(JSON.stringify(errors));
				return;
			}

			// Fetch the user
			getUser(req.body.id, function(err, user) {
				if (err) {
					res.writeHead(412, 'bad entity', { 'content-type': 'application/json' });
					res.end(JSON.stringify({errors:['Invalid username or password.']}));
					return;
				}

				// Check password
				checkPassword(req.body.password, user.password, function(err) {
					if (err) {
						res.writeHead(412, 'bad entity', { 'content-type': 'application/json' });
						res.end(JSON.stringify({errors:['Invalid username or password.']}));
						return;
					}

					// Create the session
					createSession(req.body.id, function(err, session) {
						if (err || !session) {
							return ERRinternal(req, res, 'Failed to create session info in DB', err);
						}

						// Set new session cookie
						req.session = session.id;
						res.send(204);
					});
				});
			});
		}
	}
);

// Users
// =====
server.get('/u',
	authorize,
	ERRtodo
);
server.get('/u/:userId',
	authorize,
	ERRtodo
);


// Apps
// ====
server.get('/a',
	authorize,
	ERRtodo
);
server.get('/a/:appId',
	authorize,
	ERRtodo
);


// Query Helpers
// ==============
function getUser(userId, cb) {
	server.pgClient.query('SELECT * FROM users WHERE id=$1', [userId], function(err, res) {
		if (err) {
			return cb(err);
		}
		if (res.rows.length === 0) {
			cb(null, null);
		} else {
			cb(null, res.rows[0]);
		}
	});
}
function getSession(sessionId, cb) {
	// Validate input
	if (uuidRE.test(sessionId) == false) {
		return cb(null, null);
	}

	// Fetch session
	server.pgClient.query('SELECT * FROM sessions WHERE id=$1', [sessionId], function(err, res) {
		if (err) {
			return cb(err);
		}
		if (res.rows.length === 0) {
			cb(null, null);
		} else {
			cb(null, res.rows[0]);
		}
	});
}
function createSession(userId, cb) {
	server.pgClient.query('INSERT INTO sessions (id, user_id) VALUES(uuid_generate_v4(), $1) RETURNING id', [userId], function(err, res) {
		if (err) {
			return cb(err);
		}
		if (res.rows.length === 0) {
			cb(null, null);
		} else {
			cb(null, res.rows[0]);
		}
	});
}


// Business Logic
// ==============
var uuidRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateSessionCreate(body) {
	if (!body) {
		return { errors: ['Body is required.'] };
	}
	var errors = [];
	if (body.id && typeof body.id != 'string') {
		errors.push('`id` must be a string');
	}
	if (body.password && typeof body.password != 'string') {
		errors.push('`password` must be a string');
	}
	if (errors.length > 0) {
		return { errors: errors };
	}
	return false;
}
function checkPassword(plaintext, encrypted, cb) {
	// :TODO: for now, no encryption is in place
	cb(plaintext != encrypted);
}


// Common Middleware
// =================

// Auth
// - adds response.locals.authedUserId and authedUserName on success
function authorize(request, response, next) {
	var user = parseAuthBasic(request.headers.authorization);
	var query = [
		'SELECT id FROM users',
			'WHERE name = $1',
			'AND password = $2',
			'AND status = \'Active\''
	].join(' ');
	server.pgClient.query(query, [user[0], user[1]], function(err, res) {
		if (err)
			return ERRinternal(request, response, 'Failed to fetch user record from DB', err);

		if (!res.rows[0])
			return ERRforbidden(request, response, 'Invalid auth credentials');

		request.params.authedUserId = res.rows[0].id;
		request.params.authedUserName = user[0];
		next();
	});
}
function parseAuthBasic(authHeader) {
	if (!authHeader || authHeader.indexOf('Basic ') !== 0)
		return null;
	authHeader = new Buffer(authHeader.slice(6).trim(), 'base64').toString();
	return authHeader.split(':');
}

function setCorsHeaders(request, response, next) {
	response.setHeader('Access-Control-Allow-Origin', request.headers.origin || '*');
	response.setHeader('Access-Control-Allow-Credentials', true);
	response.setHeader('Access-Control-Allow-Methods', 'OPTIONS, HEAD, GET, PUT, PATCH, POST, DELETE, NOTIFY, SUBSCRIBE');
	response.setHeader('Access-Control-Allow-Headers', request.headers['access-control-request-headers'] || '');
	response.setHeader('Access-Control-Expose-Headers', request.headers['access-control-request-headers'] || 'Content-Type, Content-Length, Date, ETag, Last-Modified, Link, Location');
	next();
}


// Error Responses
// ===============
function ERRforbidden(request, response, msg) { response.writeHead(403, 'forbidden'); response.end((typeof msg == 'string') ? msg : undefined); }
function ERRnotfound(request, response, msg) { response.writeHead(404, 'not found'); response.end((typeof msg == 'string') ? msg : undefined); }
function ERRbadmethod(request, response, msg) { response.writeHead(405, 'bad method'); response.end((typeof msg == 'string') ? msg : undefined); }
function ERRbadaccept(request, response, msg) { response.writeHead(406, 'bad accept'); response.end((typeof msg == 'string') ? msg : undefined); }
function ERRbadent(request, response, msg) { response.writeHead(422, 'bad entity'); response.end((typeof msg == 'string') ? msg : undefined); }
function ERRtodo(request, response, msg) { response.writeHead(503, 'not yet implemented'); response.end((typeof msg == 'string') ? msg : undefined); }
function ERRinternal(request, response, msg, exception) {
	console.error(msg, exception);
	response.writeHead(500, 'internal error');
	response.end(msg);
}


// Setup
// =====
server.pgClient.connect(function(err) {
	if (err) {
		console.error("Failed to connect to postgres", err);
		process.exit();
	}
});
server.listen(8000);
server.startTime = new Date();
console.log('Management HTTP server listening on port 8000');