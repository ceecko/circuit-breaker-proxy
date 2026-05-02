const assert = require('assert')
const ProxyWithCircuitBreaker = require("../src/circuit-breaker-proxy")
const sinon = require('sinon')
const { ConsecutiveBreaker } = require('cockatiel')

describe('ProxyWithCircuitBreaker', () => {
  let clientA, clientB, handleWhen, clients

  beforeEach(() => {
    // 1. Create mock clients with a dummy method
    clientA = { getData: sinon.stub() }
    clientB = { getData: sinon.stub() }
    clients = [clientA, clientB]

    // 2. Define a condition: handle errors where message is 'retry-me'
    handleWhen = sinon.stub().callsFake((err) => err.message === 'retry-me')
  })

  afterEach(() => {
    sinon.restore()
  })

  it('should successfully return data from the first client', (done) => {
    const proxy = ProxyWithCircuitBreaker.create(clients, handleWhen, {
      halfOpenAfter: 10000,
      breaker: new ConsecutiveBreaker(3),
    })
    const expectedData = { id: 1 }

    // Setup: clientA succeeds
    clientA.getData.callsArgWith(1, null, expectedData)

    proxy.getData('param1', (err, result) => {
      try {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(result, expectedData)
        assert.strictEqual(clientA.getData.calledOnce, true)
        done()
      } catch (e) {
        done(e)
      }
    })
  })

  it('should rotate clients (Round Robin) on consecutive calls', (done) => {
    const proxy = ProxyWithCircuitBreaker.create(clients, handleWhen, {
      halfOpenAfter: 10000,
      breaker: new ConsecutiveBreaker(3),
    })
    clientA.getData.callsArgWith(0, null, 'res1')
    clientB.getData.callsArgWith(0, null, 'res2')

    // First call uses clientA (index 0)
    proxy.getData((err1, res1) => {
      // Second call should use clientB (index 1)
      proxy.getData((err2, res2) => {
        try {
          assert.strictEqual(res1, 'res1')
          assert.strictEqual(res2, 'res2')
          assert.strictEqual(clientA.getData.calledOnce, true)
          assert.strictEqual(clientB.getData.calledOnce, true)
          done()
        } catch (e) {
          done(e)
        }
      })
    })
  })

  it('should failover to the next client if the first returns a handleable error', (done) => {
    const proxy = ProxyWithCircuitBreaker.create(clients, handleWhen, {
      halfOpenAfter: 10000,
      breaker: new ConsecutiveBreaker(3),
    })
    const retryError = new Error('retry-me')
    const successData = 'recovered'

    // clientA fails with a handleable error, clientB succeeds
    clientA.getData.callsArgWith(0, retryError)
    clientB.getData.callsArgWith(0, null, successData)

    proxy.getData((err, result) => {
      try {
        assert.strictEqual(result, successData)
        assert.strictEqual(clientA.getData.calledOnce, true)
        assert.strictEqual(clientB.getData.calledOnce, true)
        done()
      } catch (e) {
        done(e)
      }
    })
  })

  it('should throw immediately if the error is NOT handleable', (done) => {
    const proxy = ProxyWithCircuitBreaker.create(clients, handleWhen, {
      halfOpenAfter: 10000,
      breaker: new ConsecutiveBreaker(3),
    })
    const fatalError = new Error('fatal-error')

    clientA.getData.callsArgWith(0, fatalError)

    proxy.getData((err, result) => {
      try {
        assert.strictEqual(err, fatalError)
        assert.strictEqual(clientB.getData.called, false, 'Should not have tried clientB')
        done()
      } catch (e) {
        done(e)
      }
    })
  })

  it('should trip the circuit breaker and reset after the timeout', async () => {
    const clock = sinon.useFakeTimers()

    const halfOpenAfter = 1000
    const proxy = ProxyWithCircuitBreaker.create([clientA], handleWhen, {
      halfOpenAfter,
      breaker: new ConsecutiveBreaker(3),
    })

    const retryError = new Error('retry-me')
    clientA.getData.callsArgWith(0, retryError)

    // Trip the breaker (3 failures)
    const callProxy = () => new Promise(resolve => proxy.getData(resolve))
    await callProxy()
    await callProxy()
    await callProxy()

    // Verify it is OPEN
    clientA.getData.resetHistory()
    await new Promise((resolve) => {
      proxy.getData(err => {
        assert.strictEqual(clientA.getData.called, false, 'Should not call client when OPEN')
        assert.match(err.message, /All clients unavailable/, 'Should return the "unavailable" error')
        resolve(null)
      })
    })

    // TELEPORT: Move time forward by 1001ms
    clock.tick(halfOpenAfter+1)

    // Verify it is now HALF-OPEN (allows a call)
    clientA.getData.resetBehavior()
    clientA.getData.callsArgWith(0, null, 'success-after-reset')

    await new Promise((resolve, reject) => {
      proxy.getData((err, result) => {
        try {
          assert.strictEqual(err, null)
          assert.strictEqual(result, 'success-after-reset')
          assert.strictEqual(clientA.getData.calledOnce, true)
          resolve(null)
        } catch (e) {
          reject(e)
        }
      })
    })

    clock.restore()
  })

  it('should throw error if the last argument is not a function', () => {
    const proxy = ProxyWithCircuitBreaker.create([clientA], handleWhen, {
      halfOpenAfter: 10000,
      breaker: new ConsecutiveBreaker(3),
    })
    assert.throws(() => {
      proxy.getData('no-callback-here')
    }, /Method getData expected a callback function/)
  })
})
