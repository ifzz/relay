#!/usr/bin/env node

'use strict';

const started = +new Date();

const net = require('net');
const _ = require('lodash');
const Component = require('component');

const SessionList = require('./session-list');

module.exports = Server;

const isAsciiBuffer = buf => {
	for (let i = 0; i < buf.length; i++) {
		const ch = buf.readInt8(i);
		// eslint-disable-next-line no-magic-numbers
		if (ch !== 0x00 && ch !== 0x09 && ch !== 0x0a && ch !== 0x0d && ch < 0x20 || ch >= 0x80) {
			return false;
		}
	}
	return true;
};

const defaultOpts = {
	nameValidator: name => /^\w[\w\d:]+$/.test(name),
	port: 3031,
	keepAliveInterval: 10000,
	noDelay: true,
	dumpPackets: false
};

Server.prototype = new Component();
function Server(opts) {
	Component.call(this, 'Relay server', false);

	opts = _.defaults({}, opts, defaultOpts);

	const clients = new SessionList();
	this.bind(clients);

	const accept = socket => {

		const addr = `${socket.remoteAddress}:${socket.remotePort}`;

		socket.setKeepAlive(!!opts.keepAliveInterval, opts.keepAliveInterval);
		socket.setNoDelay(!!opts.noDelay);

		console.log(`Connection received from ${addr}`);

		const client = clients.create(socket, opts);

		const on_packet_received = packet => {
			if (packet.type === 'AUTH') {
				this.warn({ msg: `Client ${client.getName()} at ${addr} attempted to send an AUTH packet` });
				client.close();
				return;
			}
			/* Loopback not permitted (including by wildcard) */
			const from = packet.local;
			const to = packet.remote;
			const via = client.getName();
			if (packet.foreign) {
				this.warn({ msg: `Not forwarding packet of type '${packet.type}' from '${via}' to '${packet.remote}' as it is marked as foreign` });
				return;
			}
			const targets = _([...clients.get(to)])
				.filter(target => target.getName() !== via && target.getName() !== from)
				.uniq()
				.value();
			/* Re-address packet for relaying */
			packet.remote = client.getName();
			for (const recipient of targets) {
				packet.local = recipient.getName();
				recipient.send(packet);
			}
			if (opts.dumpPackets) {
				/* Note: packet remote/local have been altered by this point */
				this.emit('debug', `Packet of type "${packet.type}" from "${from}" ${via === from ? '' : `(via "${via}") `}to ${targets.length ? targets.map(c => `"${c.getName()}"`).join(', ') : `"${to}" (nowhere)`}`);
				// eslint-disable-next-line no-magic-numbers
				if (packet.data.length < 400 && isAsciiBuffer(packet.data)) {
					this.emit('debug', packet.data.toString('utf8').replace(/\0/g, '\x1b[30;47m<NULL>\x1b[0m').replace(/^|\n/g, '$&Data: \t'));
				} else {
					this.emit('debug', `Data: \t[${packet.data.length} bytes of binary data]`);
				}
				this.emit('debug', '');
			}
		};

		this.$on(client, 'data', on_packet_received);
	};

	const server = net.createServer(accept);
	this.$on(server, 'listening', () => {
		this.$component.ready();
		this.emit('listening');
	});

	server.listen(opts.port, opts.host);
}

if (!module.parent) {
	const host = process.env.HOST || '::';
	const port = +process.env.PORT || defaultOpts.port;
	const server = new Server({ port, host, dumpPackets: !!process.env.DUMP });
	server.on('listening', () => console.log(`Listening on ${host}:${port}`));
	server.on('info', ({ msg }) => console.info(msg));
	server.on('warn', ({ msg }) => console.warn(msg));
	server.on('error', err => process.env.DEBUG ? console.error(err) : console.error(`ERROR: ${err && err.message || err || '<unknown>'}`));
	server.on('debug', s => console.info(((+new Date() - started) / 1000).toFixed(3) + '\t ' + s));

	process.on('SIGHUP', () => {
		console.log([
			'',
			'******************',
			'* Component tree *',
			'******************',
			'',
			Component.tree(server, { highlight: null, ready: true }),
			''
		].join('\n'));
	});
}
