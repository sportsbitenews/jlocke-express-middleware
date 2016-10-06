'use strict';

const Promise = require('bluebird');
/* eslint-disable import/no-extraneous-dependencies */
const test = require('tap').test;
const express = require('express');
const bodyParser = require('body-parser');
const elastic = require('elasticsearch');
// Not supported in the core on last versions.
const deleteByQuery = require('elastic-deletebyquery');
const makeReq = require('tiny-promisify')(require('request'), { multiArgs: true });
/* eslint-enable import/no-extraneous-dependencies */
const dbg = require('debug')('express-middleware-todb:test:elastic');

const toDb = require('../');

const port = 7777;
const url = 'localhost:9200';
const indexName = 'test1';
const elasType = 'requests3';


dbg(`Starting, connecting to the DB: ${url}`);
const db = new elastic.Client({
  host: url,
  // plugins: [deleteByQuery],
  // log: 'trace',
});
deleteByQuery(db);
const deleteByQueryP = Promise.promisify(db.deleteByQuery);


test('with DB options (Elastic)', (assert) => {
  assert.plan(21);

  const app = express();
  app.use(bodyParser.json());

  // The middleware needs an alive DB connection.
  app.use(toDb(db, { geo: true, dbOpts: { type: 'elastic', indexName, elasType } }));

  // Routes should be defined after the middlewares.
  app.get('/', (req, res) => res.send('Hello World!'));

  // So we need it ready before starting the app to avoid losing initial requests data.
  const server = app.listen(port, () => {
    dbg(`Example app listening on port: ${port}`);

    // To drop the old ones (from old test runs).
    deleteByQueryP({ index: indexName, type: elasType })
    .then(() => {
      makeReq(`http://127.0.0.1:${port}`)
      .then((httpRes) => {
        assert.equal(httpRes[1], 'Hello World!');

        // The middleware write to the DB in async to avoid force the server
        // to wait for these operation to answer more HTTP requests. So we have to
        // wait a bit here to let it finish.
        setTimeout(() => {
          db.search({
            index: indexName,
            type: elasType,
          })
          .then(
            (body) => {
              assert.deepEqual(Object.keys(body), ['took', 'timed_out', '_shards', 'hits']);
              // Only cheking some of them to KISS.
              assert.equal(body.timed_out, false);
              assert.equal(body.hits.total, 1);
              assert.equal(body.hits.max_score, 1);
              assert.equal(body.hits.hits.length, 1);
              /* eslint-disable no-underscore-dangle */
              assert.equal(body.hits.hits[0]._index, indexName);
              assert.equal(body.hits.hits[0]._type, elasType);
              assert.type(body.hits.hits[0]._id, 'string');
              assert.equal(body.hits.hits[0]._id.length, 20);
              assert.equal(body.hits.hits[0]._score, 1);
              assert.equal(body.hits.hits[0]._source.path, '/');
              assert.equal(body.hits.hits[0]._source.method, 'GET');
              assert.equal(body.hits.hits[0]._source.protocol, 'http');
              assert.equal(body.hits.hits[0]._source.ip, '::ffff:127.0.0.1');
              assert.equal(body.hits.hits[0]._source.headers.host, '127.0.0.1:7777');
              assert.equal(body.hits.hits[0]._source.headers.connection, 'close');
              assert.equal(body.hits.hits[0]._source.originalUrl, '/');
              assert.equal(body.hits.hits[0]._source.responseCode, 200);
              assert.equal(body.hits.hits[0]._source.geo.ip, '127.0.0.1');
              assert.deepEqual(Object.keys(body.hits.hits[0]._source.geo), [
                'ip', 'country_code', 'country_name', 'region_code',
                'region_name', 'city', 'zip_code', 'time_zone',
                'latitude', 'longitude', 'metro_code',
              ]);
              /* eslint-enable no-underscore-dangle */

              // We need to close to allow the test keep passing.
              server.close();
            },
            err => assert.fail(`Getting the requests: ${err.message}`)
          );
        }, 3000);
      })
      .catch(err => assert.fail(`Making the request: ${err.message}`));
    })
    .catch(err => assert.fail(`Dropping the old requests: ${err.message}`));
  });
});
