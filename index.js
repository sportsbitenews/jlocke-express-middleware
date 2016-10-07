/*
  MIT License

  Copyright (c) 2016 IBM Research Emergent Solutions
                     Jesús Pérez <jesusprubio@gmail.com>
                     Paco Martín <fmartinfdez@gmail.com>

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
*/

'use strict';

const Promise = require('bluebird');
const dbg = require('debug')('express-middleware-todb');

const getLocation = require('tiny-promisify')(require('iplocation'));

const ensureIndexes = require('./lib/ensureIndexes');


module.exports = (db, opts = { dbOpts: {} }) => {
  const dbType = opts.dbOpts.type || 'mongo';
  // Specific for MongoDB
  const mongoCol = opts.dbOpts.colName || 'requests';
  // Elastic
  const elasIndex = opts.dbOpts.indexName || 'searchbyrequest';
  const elasType = opts.dbOpts.elasType || 'requests';

  // To be sure that the proper indexes exist.
  ensureIndexes(db, {
    // The default is mongo
    type: dbType,
    mongo: { col: mongoCol },
    elastic: { index: elasIndex, type: elasType },
  })
  .then(() => dbg('Indexes are correct'))
  .catch((err) => { throw Error(`Doing the index stuff: ${err.message}`); });

  return (req, res, next) => {
    dbg('New request');

    // We don't want to wait until the DB write is done to keep answering to more HTTP requests.
    next();

    const meta = {
      path: req.path,
      method: req.method,
      protocol: req.protocol,
      ip: req.ip,
      headers: req.headers,
      originalUrl: req.originalUrl,
      responseCode: res.statusCode,
      timestamp: new Date(),
    };
    if (Object.keys(req.params).length > 0) {
      meta.params = req.param;
      dbg('Parameters found:', req.params);
    }
    if (Object.keys(req.body).length > 0) {
      meta.body = req.body;
      dbg('Body found:', req.body);
    }

    // We need to wait for the route to finish to get the correct statusCode.
    res.on('finish', () => {
      dbg('Request ended');

      // Adding geolocation info if the proper options is passed.
      // We only need to check for it if the user pass the option. (default: false).
      let getId = Promise.resolve();
      if (opts.idFunc) {
        // TODO: Confirm that also works with LoopBack. ("res.app")
        getId = opts.idFunc(req, res);
        dbg('The user passed a function to get the user ID ...');
      }

      // We only need to check for it if the user pass the option. (default: false).
      let getLoc = Promise.resolve();
      // Adding geolocation info if the proper options is passed.
      if (opts.geo && req.ip) {
        getLoc = getLocation(req.ip);
        dbg('The user asked for the location ...');
      }

      Promise.join(getId, getLoc)
      .then((result) => {
        if (result[0]) { meta.userId = result[0]; }
        if (result[1]) { meta.geo = result[1]; }
        dbg('Inserting found request metadata in the DB', meta);

        let op;
        // MongoDB is the default option.
        // Checking that it's not a MongoDB instance -> should be Elastic.
        if (opts.dbOpts && opts.dbOpts.type === 'elastic') {
          // Formating geo data for Elastic. The field name "location" is mandatory:
          // https://www.elastic.co/guide/en/elasticsearch/guide/current/lat-lon-formats.html

          if (meta.geo &&
            // "longitude" and "latitude" can be 0.
            (meta.geo.longitude || meta.geo.longitude === 0) &&
            (meta.geo.latitude || meta.geo.latitude === 0)) {
            meta.location = [meta.geo.longitude, meta.geo.latitude];
          }

          op = db.index({
            index: elasIndex,
            type: elasType,
            body: meta,
          });
        } else {
          // Formating geo data for MongoDB.
          // https://docs.mongodb.com/manual/core/2dsphere/
          if (meta.geo &&
            (meta.geo.longitude || meta.geo.longitude === 0) &&
            (meta.geo.latitude || meta.geo.latitude === 0)) {
            meta.location = { type: 'Point', coordinates: [meta.geo.longitude, meta.geo.latitude] };
          }

          op = db.collection(mongoCol).insertOne(meta);
        }

        op
        .then(() => dbg('New metadata correctly inserted'))
        .catch((err) => { throw Error(`Adding the requests metadata: ${err.message}`); });
      })
      .catch((err) => { throw Error(`Getting the user ID or IP geolocation: ${err.message}`); });
    });
  };
};
