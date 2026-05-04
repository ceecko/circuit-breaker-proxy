# Circuit break proxy

A Node.js proxy (not an HTTP proxy) which supports applying circuit breaker logic across a set of generic clients.
You provide a list of generic clients and this package routes calls to the clients in a round-robin fashion.
If any of the clients fails to process a function call, the call is retried with the next client.
If a client continuously fails to respond to function calls, it can be temporarily removed from the list.

- For now only functions with callbacks are supported.
- Uses [cockatiel](https://github.com/connor4312/cockatiel) to handle circuit breaker logic

## Example
A good example is with a `node-etcd` client across many different hosts where each host is expected to provide the same response:

```js
const circuitBreakerProxy = require('@ceecko/circuit-breaker-proxy')
const Etcd = require('node-etcd')

const proxy = circuitBreakerProxy.create([
  new Etcd('host1.example.com'),
  new Etcd('host2.example.com'),
  new Etcd('host3.example.com'),
], err => {
  // If the error is related to network, continue with the next client.
  if(err instanceof NetworkError) return true
  
  // If it's non-network related error, return it straightaway
  return false
}, () => ({
    // If a client fails 3 times in a row, remove it for 10 seconds
    halfOpenAfter: 10000,
    breaker: new ConsecutiveBreaker(3),
}))

proxy.get('key', (err, data) => {
  // ... process data
})
```
