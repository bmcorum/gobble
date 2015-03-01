import { join, resolve } from 'path';
import * as sander from 'sander';
import { mkdir, readdirSync, rimrafSync } from 'sander';
import Node from './Node';
import session from '../session';
import queue from '../queue';
import GobbleError from '../utils/GobbleError';
import assign from '../utils/assign';
import uid from '../utils/uid';
import makeLog from '../utils/makeLog';
import config from '../config';
import warnOnce from '../utils/warnOnce';
import extractLocationInfo from '../utils/extractLocationInfo';

export default Node.extend({
	init: function ( input, transformer, options, id ) {
		var node = this;

		node.input = input;

		node.inspectTargets = [];
		node.transformer = transformer;
		node.options = assign( {}, options );

		node.name = id || transformer.id || transformer.name || 'unknown';
		node.id = uid( node.name );

		// Double callback style deprecated as of 0.6.x. TODO remove this eventually
		if ( transformer.length === 5 ) {
			warnOnce( 'The gobble plugin API has changed - the "%s" transformer should take a single callback. See https://github.com/gobblejs/gobble/wiki/Troubleshooting for more info', node.name );

			node.transformer = function ( inputdir, outputdir, options, callback ) {
				return transformer.call( this, inputdir, outputdir, options, function () {
					callback();
				}, callback );
			};
		}

		node.counter = 1;
	},

	ready: function () {
		var node = this, outputdir, transformation;

		if ( !node._ready ) {
			transformation = {
				node: node,
				cachedir: resolve( session.config.gobbledir, node.id, '.cache' ),
				log: makeLog( node ),
				env: config.env,
				sander: sander
			};

			node._abort = function () {
				node._ready = null;
				transformation.aborted = true;
			};

			outputdir = resolve( session.config.gobbledir, node.id, '' + node.counter++ );
			node._ready = mkdir( outputdir ).then( function () {
				return node.input.ready().then( function ( inputdir ) {
					return queue.add( function ( fulfil, reject ) {
						var promise, called, callback, start;

						node.emit( 'info', {
							code: 'TRANSFORM_START',
							progressIndicator: true,
							id: node.id
						});

						start = Date.now();

						callback = function ( err ) {
							var gobbleError, stack, loc;

							if ( called ) {
								return;
							}

							called = true;

							if ( err ) {
								stack = err.stack || new Error().stack;

								loc = extractLocationInfo( err );

								gobbleError = new GobbleError({
									message: 'transformation failed',
									id: node.id,
									code: 'TRANSFORMATION_FAILED',
									original: err,
									stack: stack,
									file: loc.file,
									line: loc.line,
									column: loc.column
								});

								reject( gobbleError );
							}

							else {
								node.emit( 'info', {
									code: 'TRANSFORM_COMPLETE',
									id: node.id,
									duration: Date.now() - start
								});

								node._cleanup( outputdir );
								fulfil( outputdir );
							}
						};

						try {
							promise = node.transformer.call( transformation, inputdir, outputdir, assign({}, node.options ), callback );

							if ( promise && typeof promise.then === 'function' ) {
								promise.then( function () {
									callback(); // ensure no argument is passed
								}).catch( callback );
							}
						} catch ( err ) {
							callback( err );
						}
					});
				}).catch( function ( err ) {
					node._abort();
					queue.abort();

					throw err;
				});
			});
		}

		return node._ready;
	},

	start: function () {
		var node = this;

		if ( this._active ) {
			return;
		}

		this._active = true;

		// Propagate errors and information
		this._onerror = function ( err ) {
			node._abort();
			node.emit( 'error', err );
		};

		this._oninfo = function ( details ) {
			node.emit( 'info', details );
		};

		node.input.on( 'error', this._onerror );
		node.input.on( 'info', this._oninfo );

		mkdir( session.config.gobbledir, node.id ).then( function () {
			node.input.start();
		}).catch( function ( err ) {
			node.emit( 'error', err );
		});
	},

	stop: function () {
		this.input.off( 'error', this._onerror );
		this.input.off( 'info', this._oninfo );

		this.input.stop();
		this._active = false;
	},

	_cleanup: function ( latest ) {
		var node = this, dir = join( session.config.gobbledir, node.id );

		// Remove everything except the last successful outputdir and the cachedir
		// Use readdirSync to eliminate race conditions
		readdirSync( dir ).filter( function ( file ) {
			return file !== '.cache' && resolve( dir, file ) !== latest;
		}).forEach( function ( file ) {
			rimrafSync( dir, file );
		});
	}
});