const { circuitBreaker, handleWhen, isBrokenCircuitError } = require('cockatiel')
const { promisify } = require('util')

const EXECUTE_WITH_CALLBACK = Symbol('executeWithCallback')
const EXECUTE_RESILIENTLY = Symbol('executeResiliently')

const stateMap = new WeakMap()

class ProxyWithCircuitBreaker {
  /**
   * @template T
   * @param {T[]} clients An array of client instances accepting callback in functions.
   * @param {(error: Error) => boolean} handleWhenCondition
   * @param {() => import('cockatiel').ICircuitBreakerOptions} circuitBreakerOpts
   * @returns {ProxyWithCircuitBreaker & T}
   */
  static create(clients, handleWhenCondition, circuitBreakerOpts) {
    return /** @type {any} */ (new ProxyWithCircuitBreaker(clients, handleWhenCondition, circuitBreakerOpts))
  }

  /**
   * @param {any[]} clients An array of client instances accepting callback in functions.
   * @param {(error: Error) => boolean} handleWhenCondition
   * @param {() => import('cockatiel').ICircuitBreakerOptions} circuitBreakerOpts
   * @returns 
   */
  constructor(clients, handleWhenCondition, circuitBreakerOpts) {
    const registry = clients.map(client => ({
      client,
      breaker: circuitBreaker(handleWhen(handleWhenCondition), circuitBreakerOpts())
    }))

    // Store everything in the WeakMap to avoid instance collisions
    stateMap.set(this, {
      registry,
      currentIndex: 0,
      handleWhenCondition
    })

    return new Proxy(this, {
      get: (target, prop) => {
        // Prioritize Internal Symbols (for logic inside the class)
        if (typeof prop === 'symbol') {
          return target[prop]
        }

        return (...args) => target[EXECUTE_WITH_CALLBACK](prop, args)
      }
    })
  }

  [EXECUTE_WITH_CALLBACK](methodName, args) {
    const callback = args.pop()

    if (typeof callback !== 'function') {
      throw new Error(`Method ${methodName} expected a callback function.`)
    }

    this[EXECUTE_RESILIENTLY](methodName, args)
      .then(result => callback(null, result))
      .catch(err => callback(err))
  }

  async [EXECUTE_RESILIENTLY](methodName, args) {
    const state = stateMap.get(this)
    const len = state.registry.length
    
    // ATOMIC START: Grab our starting slot and move the global pointer once.
    // This ensures the NEXT request starts somewhere else.
    const startingIndex = state.currentIndex
    state.currentIndex = (startingIndex + 1) % len

    let attempts = 0
    let lastError = null

    while (attempts < len) {
      // LOCAL ROTATION: We calculate our index based on our starting slot.
      // This ensures this specific request tries every client in order.
      const index = (startingIndex + attempts) % len;
      const { client, breaker } = state.registry[index];

      try {
        if (typeof client[methodName] !== 'function') {
          throw new Error(`Method ${methodName} not found on client`)
        }

        const fn = promisify(client[methodName]).bind(client)
        const res = await breaker.execute(() => fn(...args))
        return res
      } catch (error) {
        if(isBrokenCircuitError(error)) {
          attempts++
          continue
        }
        
        // Only retry if it's a "handleable" error
        if (!state.handleWhenCondition(error)) throw error
        
        lastError = error
        attempts++
      }
    }

    throw lastError || new Error("All clients unavailable or failed")
  }
}

module.exports = ProxyWithCircuitBreaker
