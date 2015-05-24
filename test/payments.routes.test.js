/**
 * Dependencies.
 */
var expect    = require('chai').expect;
var request   = require('supertest');
var _         = require('lodash');
var async     = require('async');
var sinon     = require('sinon');
var nock      = require('nock');
var app       = require('../index');
var utils     = require('../test/utils.js')();
var config    = require('config');

/**
 * Variables.
 */
var STRIPE_URL = 'https://api.stripe.com:443';
var CHARGE = 10.99;
var CURRENCY = 'USD';
var STRIPE_TOKEN = 'superStripeToken';
var userData = utils.data('user1');
var groupData = utils.data('group1');
var transactionsData = utils.data('transactions1').transactions;
var models = app.set('models');
var stripeMock = require('./mocks/stripe');

/**
 * Tests.
 */
describe('payments.routes.test.js', function() {

  var application, application2, user, group, group2;
  var nocks = {};

  beforeEach(function(done) {
    utils.cleanAllDb(function(e, app) {
      application = app;
      done();
    });
  });

  // Create a user.
  beforeEach(function(done) {
    models.User.create(userData).done(function(e, u) {
      expect(e).to.not.exist;
      user = u;
      done();
    });
  });

  // Stripe stub.
  var stubAccountsCreate;
  beforeEach(function() {
    stubAccountsCreate = sinon.stub(app.stripe.accounts, 'create');
    stubAccountsCreate.yields(null, stripeMock.accounts.create);
  });
  afterEach(function() {
    app.stripe.accounts.create.restore();
  });

  // Nock for customers.create.
  beforeEach(function() {
    nocks['customers.create'] = nock(STRIPE_URL)
      .post('/v1/customers')
      .reply(200, stripeMock.customers.create);
  });
  // Nock for charges.create.
  beforeEach(function() {
    nocks['charges.create'] = nock(STRIPE_URL)
      .post('/v1/charges', 'amount=' + CHARGE*100 + '&currency=' + CURRENCY + '&customer=' + stripeMock.customers.create.id)
      .reply(200, stripeMock.charges.create);
  });
  afterEach(function() {
    nock.cleanAll();
  });

  // Create a group.
  beforeEach(function(done) {
    request(app)
      .post('/groups')
      .set('Authorization', 'Bearer ' + user.jwt(application))
      .send({
        group: groupData,
        role: 'admin'
      })
      .expect(200)
      .end(function(e, res) {
        expect(e).to.not.exist;
        models.Group
          .find(parseInt(res.body.id))
          .then(function(g) {
            group = g;
            done();
          })
          .catch(done);
      });
  });

  // Create a second group.
  beforeEach(function(done) {
    request(app)
      .post('/groups')
      .set('Authorization', 'Bearer ' + user.jwt(application))
      .send({
        group: utils.data('group2')
      })
      .expect(200)
      .end(function(e, res) {
        expect(e).to.not.exist;
        models.Group
          .find(parseInt(res.body.id))
          .then(function(g) {
            group2 = g;
            done();
          })
          .catch(done);
      });
  });

  // Create an application which has only access to `group`
  beforeEach(function(done) {
    models.Application.create(utils.data('application2')).done(function(e, a) {
      expect(e).to.not.exist;
      application2 = a;
      application2.addGroup(group2).done(done);
    });
  });


  /**
   * Post a payment.
   */
  describe('#postPayments', function() {

    describe('Payment success by a group\'s user', function() {

      beforeEach(function(done) {
        request(app)
          .post('/groups/' + group.id + '/payments')
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .send({
            payment: {
              stripeToken: STRIPE_TOKEN,
              amount: CHARGE,
              currency: CURRENCY
            }
          })
          .expect(200)
          .end(done);
      });

      it('successfully creates a Stripe customer', function() {
        expect(nocks['customers.create'].isDone()).to.be.true;
      });

      it('successfully creates a card with the UserId and the GroupId', function(done) {
        models.Card
          .findAndCountAll({})
          .then(function(res) {
            expect(res.count).to.equal(1);
            expect(res.rows[0]).to.have.property('GroupId', group.id);
            expect(res.rows[0]).to.have.property('UserId', user.id);
            expect(res.rows[0]).to.have.property('token', STRIPE_TOKEN);
            expect(res.rows[0]).to.have.property('service', 'stripe');
            expect(res.rows[0]).to.have.property('serviceId', stripeMock.customers.create.id);
            done();
          })
          .catch(done);
      });

      it('successfully makes a Stripe charge', function() {
        expect(nocks['charges.create'].isDone()).to.be.true;
      });

      it('successfully creates a transaction in the database', function(done) {
        models.Transaction
          .findAndCountAll({})
          .then(function(res) {
            expect(res.count).to.equal(1);
            expect(res.rows[0]).to.have.property('GroupId', group.id);
            expect(res.rows[0]).to.have.property('UserId', user.id);
            expect(res.rows[0]).to.have.property('CardId', 1);
            expect(res.rows[0]).to.have.property('currency', CURRENCY.toLowerCase());
            expect(res.rows[0]).to.have.property('type', 'payment');
            expect(res.rows[0]).to.have.property('amount', CHARGE);
            expect(res.rows[0]).to.have.property('paidby', user.id.toString());
            expect(res.rows[0]).to.have.property('approved', true);
            done();
          })
          .catch(done);
      });

    });


    describe('Next payment success with a same stripe token', function() {

      var CHARGE2 = 1.99;

      beforeEach(function(done) {
        request(app)
          .post('/groups/' + group.id + '/payments')
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .send({
            payment: {
              stripeToken: STRIPE_TOKEN,
              amount: CHARGE,
              currency: CURRENCY
            }
          })
          .expect(200)
          .end(done);
      });

      // New nock for customers.create.
      beforeEach(function() {
        nocks['customers.create2'] = nock(STRIPE_URL)
          .post('/v1/customers')
          .reply(200, stripeMock.customers.create);
      });
      // New nock for charges.create.
      beforeEach(function() {
        nocks['charges.create2'] = nock(STRIPE_URL)
          .post('/v1/charges', 'amount=' + CHARGE2*100 + '&currency=' + CURRENCY + '&customer=' + stripeMock.customers.create.id)
          .reply(200, stripeMock.charges.create);
      });

      beforeEach(function(done) {
        request(app)
          .post('/groups/' + group.id + '/payments')
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .send({
            payment: {
              stripeToken: STRIPE_TOKEN,
              amount: CHARGE2,
              currency: CURRENCY
            }
          })
          .expect(200)
          .end(done);
      });

      it('does not re-create a Stripe Customer with a same token', function() {
        expect(nocks['customers.create2'].isDone()).to.be.false;
      });

      it('does not re-create a card', function(done) {
        models.Card
          .findAndCountAll({})
          .then(function(res) {
            expect(res.count).to.equal(1);
            done();
          })
          .catch(done);
      });

      it('successfully makes a new Stripe charge', function() {
        expect(nocks['charges.create2'].isDone()).to.be.true;
      });

      it('successfully creates a new transaction', function(done) {
        models.Transaction
          .findAndCountAll({})
          .then(function(res) {
            expect(res.count).to.equal(2);
            expect(res.rows[1]).to.have.property('amount', CHARGE2);
            done();
          })
          .catch(done);
      });

    });


    describe('Payment success by a user that is not part of the group yet', function() {

      beforeEach(function(done) {
        request(app)
          .post('/groups/' + group2.id + '/payments')
          .set('Authorization', 'Bearer ' + user.jwt(application2))
          .send({
            payment: {
              stripeToken: STRIPE_TOKEN,
              amount: CHARGE,
              currency: CURRENCY
            }
          })
          .expect(200)
          .end(done);
      });

      it('successfully adds the user to the group as a viewer', function(done) {
        group2
          .getMembers()
          .then(function(users) {
            expect(users).to.have.length(1);
            expect(users[0].UserGroup.role).to.equal('viewer');
            done();
          })
          .catch(done);
      });

    });


    describe('Payment success by anonymous user', function() {

      beforeEach('successfully makes a anonymous payment', function(done) {
        request(app)
          .post('/groups/' + group2.id + '/payments')
          .send({
            api_key: application2.api_key,
            payment: {
              stripeToken: STRIPE_TOKEN,
              amount: CHARGE,
              currency: CURRENCY
            }
          })
          .expect(200)
          .end(function(e, res) {
            expect(e).to.not.exist;
            done();
          });
      });

      it('successfully creates a Stripe customer', function() {
        expect(nocks['customers.create'].isDone()).to.be.true;
      });

      it('successfully creates a card with the GroupId', function(done) {
        models.Card
          .findAndCountAll({})
          .then(function(res) {
            expect(res.count).to.equal(1);
            expect(res.rows[0]).to.have.property('GroupId', group2.id);
            expect(res.rows[0]).to.have.property('UserId', null);
            done();
          })
          .catch(done);
      });

      it('successfully makes a Stripe charge', function() {
        expect(nocks['charges.create'].isDone()).to.be.true;
      });

      it('successfully creates a transaction in the database', function(done) {
        models.Transaction
          .findAndCountAll({})
          .then(function(res) {
            expect(res.count).to.equal(1);
            expect(res.rows[0]).to.have.property('GroupId', group2.id);
            expect(res.rows[0]).to.have.property('UserId', null);
            expect(res.rows[0]).to.have.property('CardId', 1);
            done();
          })
          .catch(done);
      });

    });


    describe.skip('Recurrent payment success', function() {
      // There are 2 options:
      //   - The API itself creates charge every X
      //   - We use Stripe subscriptions
    });

  });

});
