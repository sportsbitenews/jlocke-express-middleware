/*
  Copyright (c) 2016 IBM Research Emergent Solutions
                     Jesús Pérez <jesusprubio@gmail.com>
                     Paco Martín <fmartinfdez@gmail.com>

  This code may only be used under the MIT style license found at
  https://ibmresearch.github.io/LICENSE.txt
*/

'use strict';

const Promise = require('bluebird');
/* eslint-disable import/no-extraneous-dependencies */
const test = require('tap').test;
const express = require('express');
const bodyParser = require('body-parser');
const elastic = require('elasticsearch');
const makeReq = require('tiny-promisify')(require('request'), { multiArgs: true });
/* eslint-enable import/no-extraneous-dependencies */
const dbg = require('debug')('jlocke-express-middleware:test:elastic');

const toDb = require('../');

const port = 4444;
const url = 'localhost:9200';
const indexName = 'searchbyrequest';
const elasType = 'requests';
const excludePath = 'login';
const excludeField = 'password';
const badLoginMsg = 'login failed';


dbg(`Starting, connecting to the DB: ${url}`);
const db = new elastic.Client({
  host: url,
  // log: 'trace',
});


test('with DB options (Elastic)', (assert) => {
  assert.plan(21);

  // To drop the old ones (from old test runs).
  dbg('Checking if the indexes exist ...');
  db.indices.exists({ index: indexName })
  .then((exists) => {
    let deleteIndex = Promise.resolve();
    if (exists) { deleteIndex = db.indices.delete({ index: indexName }); }

    deleteIndex
    .then(() => {
      const app = express();
      app.use(bodyParser.json());

      // The middleware needs an alive DB connection.
      app.use(toDb(db, { hide: { path: excludePath, field: excludeField } }));

      // Routes should be defined after the middlewares.
      app.get('/', (req, res) => res.send('Hello World!'));

      app.post('/login', (req, res) => {
        if (req.body.username === 'ola') {
          res.send({ username: 'test', token: 'aaa' });
        } else {
          res.status(401).send(badLoginMsg);
        }
      });

      // So we need it ready before starting the app to avoid losing initial requests data.
      const server = app.listen(port, () => {
        dbg(`Example app listening on port: ${port}`);
        const reqOpts = {
          url: `http://127.0.0.1:${port}/login`,
          method: 'POST',
          json: { username: 'ola', password: 'kase' },
        };
        makeReq(reqOpts)
        .then((httpRes) => {
          assert.equal(httpRes[0].statusCode, 200);

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
                assert.equal(body.hits.hits[0]._source.path, '/login');
                assert.equal(body.hits.hits[0]._source.method, 'POST');
                assert.equal(body.hits.hits[0]._source.protocol, 'http');
                assert.equal(body.hits.hits[0]._source.ip, '127.0.0.1');
                assert.equal(body.hits.hits[0]._source.headers.host, '127.0.0.1:4444');
                assert.equal(body.hits.hits[0]._source.headers.connection, 'close');
                assert.equal(body.hits.hits[0]._source.originalUrl, '/login');
                // Elastic returns it as an string.
                assert.type(body.hits.hits[0]._source.timestamp, 'string');
                assert.equal(body.hits.hits[0]._source.responseCode, 200);
                assert.equal(body.hits.hits[0]._source.body[excludeField], undefined);
                /* eslint-enable no-underscore-dangle */

                // We need to close to allow the test keep passing.
                server.close();
              },
              err => assert.fail(`Getting the requests: ${err.message}`)
            );
          }, 3000);
        })
        .catch(err => assert.fail(`Making the request: ${err.message}`));
      });
    })
    .catch(err => assert.fail(`Dropping the old requests: ${err.message}`));
  })
  .catch(err => assert.fail(`Checking the actual indexes: ${err.message}`));
});
