const url    = require ('url')
const http   = require ('http')
const https  = require ('https')
const stream = require ('stream')

module.exports = class {

    constructor (o = {}) {
    
    	if (o.url) {
    	
    		let u = url.parse (o.url)
    		
    		for (let k of ['protocol', 'hostname', 'port', 'path']) o [k] = u [k]
    	
    	}
    
        this.o = o
        
    }
    
    async acquire () {

        return new class {
        
			constructor (o) {		
				this.o = o				
			}
			
			async release () {
				// do nothing
			}			
			
			guess_content_type (c) {
			
				switch (c) {
					case '<':
						return 'text/xml'
					case '{':
					case '[':
						return 'application/json'
					default:
						return 'text/plain'
				}
				
			}
			
			to_error (rp, rp_body) {

				let x = new Error (rp.statusCode + ' ' + rp.statusMessage)
			
				x.code = rp.statusCode
			
				x.body = rp_body
				
				return x

			}

			async response (o, body) {

				let rp_body = ''
				
				let rp = await this.responseStream (o, body)

				return new Promise ((ok, fail) => {

					rp.on ('end', () => {

						darn (this.log_prefix + ' HTTP rp b ' + JSON.stringify ([rp_body]))

						switch (rp.statusCode) {
							case 200 : return ok   (rp_body)
							default  : return fail (this.to_error (rp, rp_body))
						}

					})

					rp.setEncoding ('utf8')							

					rp.on ('data', s => rp_body += s)
				
				})

			}
			
			async responseStream (o, body) {

				if (o.url) {

					let u = url.parse (o.url)

					for (let k of ['protocol', 'hostname', 'port', 'path']) o [k] = u [k]

				}

				let has_body = body != null
				
				let is_body_stream = has_body && body instanceof stream.Readable
			
				o = Object.assign ({method: has_body ? 'POST' : 'GET'}, this.o, o)
				
				if (has_body && !is_body_stream && !o.headers && body.length > 1) o.headers = {'Content-Type': this.guess_content_type (body.charAt (0))}

				return new Promise ((ok, fail) => {
					
					let oo = o; if (o.auth) {
						oo = clone (o)
						oo.auth = oo.auth.split (':') [0] + ':XXXXXX'
					}

					darn (this.log_prefix + ' HTTP rq ' + JSON.stringify ([oo, body]))

					try {

						let rq = (/^https/.test (o.protocol) ? https : http).request (o, async rp => {
						
							let code    = rp.statusCode							
							let headers = rp.headers

							darn (this.log_prefix + ' HTTP rp h ' + JSON.stringify ([code, headers]))

							rp.on ('error', x => fail (x))
							
							let {location} = headers; if (!location) return ok (rp)
							
				    		let u = url.parse (location)

				    		for (let k of ['protocol', 'hostname', 'port', 'path']) if (u [k]) o [k] = u [k]
				    		
				    		delete o.url

				    		ok (await this.responseStream (o, body))
							
						})

						rq.on ('error', x => fail (x))	

						is_body_stream ? body.pipe (rq) : has_body ? rq.end (body) : rq.end ()

					}
					catch (x) {

						fail (x)

					}

				})

			}
        
        } (this.o)
        
    }    

}