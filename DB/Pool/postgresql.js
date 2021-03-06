const {Pool} = require ('pg')
const wrapper = require ('../Client/postgresql.js')
const crypto  = require ('crypto')

module.exports = class extends require ('../Pool.js') {

    constructor (o) {
        super (o)
        this.backend = new Pool (o)
    }
    
    async listen (o) {

		let db = new (require ('pg')).Client (this.options.connectionString)		
		
		db.connect ()
		
		if (o.timers) for (let name in o.timers) {
		
			let key = 'timer_' + name
		
			let hash = crypto.createHash ('sha256')
			
			hash.update (key)
			
			let digest = hash.digest ('hex').slice (0, 16)
			
			darn (`Trying to aquire cluster wide lock for ${key} (${digest})...`)
			
			let sql = `SELECT pg_try_advisory_lock (x'${digest}'::int8) AS ok`
			
			darn (sql)			

			let rs = await db.query (sql)
			
			if (rs && rs.rows && rs.rows.length == 1 && rs.rows [0].ok) {
			
				darn (`... lock for ${key} (${digest}) acquired.`)
			
			}
			else {
						
				darn (rs)
				
				throw new Error (`... can't acquire lock for ${key} (${digest}), bailing out.`)
			
			}
			
		}
		
		let sql = 'LISTEN ' + o.name
		
		db.query (sql)
		
		db.on ('notification', async e => {

			try {

				let {payload} = e; if (payload.charAt (0) != '{') {

					if (o.timers) {

						let timer = o.timers [payload]; if (timer) {
						
							darn (sql + ': ' + payload + ' -> ' + timer.uuid)

							timer.on ()

						}

					}				

				}
				else {

					await new Promise ((ok, fail) => {

						let h = new o.handler (Object.assign ({rq: JSON.parse (payload)}, o.params), ok, fail)

						darn (sql + ': ' + payload + ' -> ' + h.uuid)

						h.run ()

					})

				}
			
			}
			catch (x) {

				darn (x)

			}

		})

		darn ('Listening for PostgreSQL notifications on ' + o.name)

    }    
    
    async acquire () {  // darn (`${this.backend.totalCount} ${this.backend.idleCount} ${this.backend.waitingCount}`)
        let raw = await this.backend.connect ()
        let c = new wrapper (raw)
        
/*    
        if (this.backend.is_txn_pending) {
            darn ('[WARNING] Got a dirty connection, rolling back uncommitted transaction')            
            (async () => {await this.rollback ()}) ()
        }
*/
        c.model = this.model
        return c
    }

    async release (client) {
        return await client.release ()
    }
    
    gen_sql_quoted_literal (s) {
        if (s == null) s = ''
        return "'" + String (s).replace(/'/g, "''") + "'"
    }
    
    gen_sql_column_definition (col) {
    
        let sql = col.TYPE_NAME
        
        if (col.COLUMN_SIZE > 0) {
            sql += '(' + col.COLUMN_SIZE
            if (col.DECIMAL_DIGITS) sql += ',' + col.DECIMAL_DIGITS
            sql += ')'
        }
        
        let def = col.COLUMN_DEF
        if (def != undefined) {
            if (def.indexOf (')') < 0) def = this.gen_sql_quoted_literal (def)
            sql += ' DEFAULT ' + def
        }
        
        if (col.NULLABLE === false) sql += ' NOT NULL'
        
        return sql

    }
    
    gen_sql_add_table (table) {
    
        let p_k = table.p_k
		let col = table.columns

        return {
            sql: `CREATE TABLE "${table.name}" (${p_k.map (k => k + ' ' + this.gen_sql_column_definition (col [k]))}, PRIMARY KEY (${p_k}))`,
            params: []
        }

    }
    
    gen_sql_recreate_views () {

        let result = []
        
        for (let name in this.model.views) {
        
        	let view = this.model.views [name]; view.depends = {}
        	
        	for (let word of view.sql.split (/\b/))
        	
        		if (this.model.views [word])

        			view.depends [word] = 1

        }
        
        let names = [], idx = {}
        
        let assert = name => {
        
        	if (idx [name]) return
        
        	for (let k in this.model.views [name].depends) assert (k)
        	
        	idx [name] = names.push (name)

        }
        
        for (let name in this.model.views) assert (name)

		let views = names.map (i => this.model.views [i])

        while (views.length && views [0]._no_recreate) views.shift ()

        for (let view of views) result.push ({sql: `DROP VIEW IF EXISTS "${view.name}" CASCADE`, params: []})

        for (let view of views) {
            
            result.push ({sql: `CREATE VIEW "${view.name}" AS ${view.sql}`, params: []})            
            result.push ({sql: `COMMENT ON VIEW "${view.name}" IS ` + this.gen_sql_quoted_literal (view.label), params: []})

            for (let col of Object.values (view.columns))                             
                result.push ({sql: `COMMENT ON COLUMN "${view.name}"."${col.name}" IS ` + this.gen_sql_quoted_literal (col.REMARK), params: []})
            
        }

        return result

    }

    gen_sql_add_tables () {

        let result = []

        for (let table of Object.values (this.model.tables)) if (!table.existing) {
        
			let existing = {columns: {}, keys: {}, triggers: {}}

			for (let k of ['pk', 'p_k']) existing         [k] = clone (table [k])
			for (let k of     table.p_k) existing.columns [k] = clone (table.columns [k])
            
            table.existing = existing
            table._is_just_added = 1

            result.push (this.gen_sql_add_table (table))

        }

        return result

    }

    gen_sql_comment_tables () {

        let result = []

        for (let table of Object.values (this.model.tables)) 
        
            if (table.label != table.existing.label)

                result.push ({sql: `COMMENT ON TABLE "${table.name}" IS ` + this.gen_sql_quoted_literal (table.label), params: []})

        for (let view of Object.values (this.model.views)) 
        
            if (view._no_recreate && view.label != view.existing.label)

                result.push ({sql: `COMMENT ON VIEW "${view.name}" IS ` + this.gen_sql_quoted_literal (view.label), params: []})

        return result

    }

    gen_sql_upsert_data () {

        let result = []
        
        for (let table of Object.values (this.model.tables)) {
        
            let data = table._data_modified
            
            if (!data || !data.length) continue
            
            for (let record of data) {
            
                let [f, s, v] = [[], [], []]
                            
                for (let k in record) {
                
                    f.push (k)
                    v.push (record [k])

                    if (!table.p_k.includes (k)) s.push (`${k}=EXCLUDED.${k}`)

                }
                
                let something = s.length ? 'UPDATE SET ' + s : 'NOTHING'
                            
                result.push ({sql: `INSERT INTO "${table.name}" (${f}) VALUES (?${',?'.repeat (f.length - 1)}) ON CONFLICT (${table.pk}) DO ${something}`, params: v})

            }
        
        }

        return result

    }
    
    gen_sql_add_column (table, col) {
    
        return {
            sql: `ALTER TABLE "${table.name}" ADD "${col.name}" ` + this.gen_sql_column_definition (col), 
            params: []
        }
    
    }
    
    gen_sql_recreate_tables () {
    
        let result = []
        
        for (let table_name in this.model.tables) {
        
            let table = this.model.tables [table_name]
            
            if (!table.existing) continue

            if ('' + table.p_k == '' + table.existing.p_k) continue
            
            let on = table.on_before_recreate_table; if (on) {
            	
            	if (typeof on === 'function') on = on (table)
            	
            	if (on == null) on = []
            	
            	if (!Array.isArray (on)) on = [on]
            	
            	result.push (...on)

            }
            
            delete table.model

            let tmp_table = clone (table)
            
            for (let t of [table, tmp_table]) t.model = this.model
            
            tmp_table.name = 't_' + String (Math.random ()).replace (/\D/g, '_')
                        
            result.push (this.gen_sql_add_table (tmp_table))
            
            let cols = []

            for (let col of Object.values (tmp_table.columns)) {

                let col_name = col.name

                if (!table.existing.columns [col_name]) continue

                cols.push (col_name)

                if (tmp_table.p_k.includes (col_name)) continue

                delete col.COLUMN_DEF
                delete table.existing.columns [col_name].COLUMN_DEF

                result.push (this.gen_sql_add_column (tmp_table, col))

            }

            result.push ({sql: `INSERT INTO ${tmp_table.name} (${cols}) SELECT ${cols} FROM ${table.name}`, params: []})

			if (tmp_table.p_k.length == 1) {
				
				let TYPE_NAME = tmp_table.columns [tmp_table.pk].TYPE_NAME

				for (let ref_table_name in this.model.tables) {

					let ref_table = ref_table_name == table.name ? tmp_table : this.model.tables [ref_table_name]

					for (let col of Object.values (ref_table.columns)) {

						if (col.ref != table.name) continue

						let tmp_col = {TYPE_NAME, ref: tmp_table, name: 'c_' + String (Math.random ()).replace (/\D/g, '_')}

						result.push (this.gen_sql_add_column (ref_table, tmp_col))
						result.push ({sql: `UPDATE ${ref_table.name} r SET ${tmp_col.name} = (SELECT ${tmp_table.pk} FROM ${table.name} v WHERE v.${table.existing.pk}=r.${col.name})`, params: []})
						result.push ({sql: `ALTER TABLE ${ref_table.name} DROP COLUMN ${col.name}`, params: []})
						result.push ({sql: `ALTER TABLE ${ref_table.name} RENAME ${tmp_col.name} TO ${col.name}`, params: []})

						ref_table.columns [col.name].TYPE_NAME = TYPE_NAME

					}

				}
				
			}

            result.push ({sql: `DROP TABLE ${table.name}`, params: []})
            result.push ({sql: `ALTER TABLE ${tmp_table.name} RENAME TO ${table.name}`, params: []})
            
            table.existing.pk  = table.pk
            table.existing.p_k = table.p_k
            for (let name of table.p_k) table.existing.columns [name] = table.columns [name]

        }        
        
        return result

    }
    
    gen_sql_add_columns () {
    
        let result = []
        
        for (let table of Object.values (this.model.tables)) {
        
            let existing_columns = table.existing.columns

            let after = table.on_after_add_column

            for (let col of Object.values (table.columns)) {

            	let {name} = col
            	
            	if (table.p_k.includes (name)) continue
            	
            	if (name in existing_columns) {
            	
            		if (after && name in after) darn (`[SCHEMA WARNING] REDUNDANT on_after_add_column: ${table.name}.${name}`)
            	
            		continue
            		
            	}

                result.push (this.gen_sql_add_column (table, col))
                                
                if (after) {
                    let a = after [name]
                    if (a) for (let i of a) result.push (i)
                }                

                existing_columns [name] = clone (col)
                
                delete existing_columns [name].REMARK

            }

        }
    
        return result
    
    }
    
    gen_sql_create_foreign_keys () {
    
        let result = []

        for (let table of Object.values (this.model.tables)) {

            let existing_columns = table.existing.columns, add = s => result.push ({sql: `ALTER TABLE "${table.name}" ${s}`, params: []})

            for (let nw of Object.values (table.columns)) {
            
            	let ol = existing_columns [nw.name]; if (ol) {
					
					if (nw.ref == ol.ref) continue
					
					let {ref_name} = ol; if (ref_name) add (`DROP CONSTRAINT ${ref_name}`)
				
				}

            	let {ref} = nw; if (ref) add (`ADD FOREIGN KEY (${nw.name}) REFERENCES ${ref} NOT VALID`)

            }

		}

        return result
    
    }

    gen_sql_set_default_columns () {

        let result = []

        for (let table of Object.values (this.model.tables)) {

            let existing_columns = table.existing.columns

            for (let col of Object.values (table.columns)) {
            
            	if (table.p_k.includes (col.name)) continue
            
                let d = col.COLUMN_DEF

                if (d != existing_columns [col.name].COLUMN_DEF) {
                
                    if (d == null) {

                        result.push ({sql: `ALTER TABLE "${table.name}" ALTER COLUMN "${col.name}" DROP DEFAULT`, params: []})

                    }
                    else {

                		let [v, params] = d.indexOf ('(') < 0 ? ['?', [d]] : [d, []]

                        result.push ({sql: `UPDATE "${table.name}" SET "${col.name}" = ${v} WHERE "${col.name}" IS NULL`, params})

                        if (d.indexOf (')') < 0) d = this.gen_sql_quoted_literal (d)

                        result.push ({sql: `ALTER TABLE "${table.name}" ALTER COLUMN "${col.name}" SET DEFAULT ${d}`, params: []})

                    }
                
                }
                
                let n = col.NULLABLE; if (n != existing_columns [col.name].NULLABLE) {

                    result.push ({sql: `ALTER TABLE "${table.name}" ALTER COLUMN "${col.name}" ${n ? 'DROP' : 'SET'} NOT NULL`, params: []})

                }

            }

        }

        return result

    }    
    
    gen_sql_comment_columns () {

        let result = []

        for (let table of [
        	...Object.values (this.model.tables),
        	...Object.values (this.model.views).filter (v => v._no_recreate),
        ]) {

            let existing_columns = table.existing.columns

            for (let col of Object.values (table.columns)) {
            
                let label = col.REMARK || '', old_label = (existing_columns [col.name] || {}).REMARK || ''

                if (label != old_label) result.push ({sql: `COMMENT ON COLUMN "${table.name}"."${col.name}" IS ` + this.gen_sql_quoted_literal (label), params: []})

            }

        }

        return result

    }    
    
    gen_sql_update_triggers () {
    
        let result = []
        
        for (let table of Object.values (this.model.tables)) {
        
            let triggers = table.triggers
        
            if (!triggers) continue
        
            let existing_triggers = (table.existing || {triggers: {}}).triggers
            
            for (let name in triggers) {
            
                let src = triggers [name]
                
                let old_src = existing_triggers [name]; if (src == old_src) continue
                
                if (old_src) {                
					darn (`[SCHEMA WARNING] TRIGGER REDEFINED (see below)`)
					darn ([table.name + '.' + name, old_src, src])                
                }
                
                let [phase, ...events] = name.toUpperCase ().split ('_')
                
                let glob = `on_${name}_${table.name}`
                
                result.push ({sql: `

                    CREATE OR REPLACE FUNCTION ${glob}() RETURNS trigger AS \$${glob}\$

                        ${src}

                    \$${glob}\$ LANGUAGE plpgsql;

                `, params: []})

                result.push ({sql: `
                
                    DROP TRIGGER IF EXISTS ${glob} ON ${table.name};
                    
                `, params: []})

                result.push ({sql: `

                    CREATE TRIGGER 
                        ${glob}
                    ${phase} ${events.join (' OR ')} ON 
                        ${table.name}
                    FOR EACH ROW EXECUTE PROCEDURE 
                        ${glob} ();

                `, params: []})
            
            }
        
        }
        
        return result

    }
    
    normalize_model_table_key (table, k) {

        let glob = `ix_${table.name}_${k}`

        let src = table.keys [k]

        if (src != null) {
            src = src.trim ()
            if (src.indexOf ('(') < 0) src = `(${src})`
            if (src.indexOf ('USING') < 0) src = src.replace ('(', 'USING btree (')
            src = src.replace ('USING', ` INDEX ${glob} ON ${table.name} USING`).trim ()
            src = 'CREATE ' + src
        }

        table.keys [k] = src

        let o = [table.keys]; for (let j of ['on_before_create_index']) if (table [j]) o.push (table [j])

        for (let h of o) if (k in h) {
        	let v = h [k]
			delete h [k]
			h [glob] = v
        }

    }

    gen_sql_update_keys () {
    
        let result = []
        
        for (let table of Object.values (this.model.tables)) {
        
            let keys = table.keys

            if (!keys) continue
        
            let existing_keys = (table.existing || {keys: {}}).keys
            
            let before = table.on_before_create_index

			for (let name in keys) {
            
                let src = keys [name]
                
                let old_src = existing_keys [name]
                
                let original_name = name.split (table.name + '_') [1]
                
           		if (old_src && before && name in before) darn (`[SCHEMA WARNING] REDUNDANT on_before_create_index: ${table.name}.${original_name}`)
                
                function invariant (s) {
                    if (s == null) return ''
                    return s
                    	.replace (/B'/g, "'")
                    	.replace (/[\s\(\)]/g, '')
                    	.replace (/::\"\w+\"/g, '')
                    	.toLowerCase ()
                }
                
                if (invariant (src) == invariant (old_src)) continue

                if (old_src) {
					darn (`[SCHEMA WARNING] INDEX REDEFINED: ${name} (see below)`)
					darn ([table.name + '.' + original_name, old_src, src])
                }

                if (old_src) {
                	result.push ({sql: `DROP INDEX IF EXISTS ${name};`, params: []})
                }
                else if (before) {
                    let b = before [name]
                    if (b) for (let i of b) result.push (i)
                }
                
                if (src != null) {
                
                	result.push ({sql: src, params: []})

                	let [, cols] = src.split (/[\(\)]/)

                    cols = cols.split (/,\s*/)
                        .map (c =>  c.match(/^(\w+)/) [0] )
                        .join (', ')

                	result.push ({sql: `VACUUM ANALYZE ${table.name} (${cols})`, params: []})

                }

            }

        }

        return result

    }

    normalize_model_table_trigger (table, k) {

        let src = table.triggers [k].replace (/\s+/g, ' ').trim ()

        if (!src.match (/^DECLARE/)) src = `BEGIN ${src} END;`
        
        const re_pseudocomment_validate = new RegExp ('\\/\\*\\+\\s*VALIDATE\\s+(\\w+)\\s*\\*\\/', 'mg')

        src = src.replace (re_pseudocomment_validate, (m, name) => {
        
        	if (name != 'ALL') return this.trg_check_column_value (table, name)
        	
        	let sql = ''; for (let name in table.columns) {
        	
        		let column = table.columns [name]

        		if (!table.model.has_validation (column)) continue
        		
        		sql += this.trg_check_column_value (table, name)
        	
        	}

       		return sql
        
        })

        table.triggers [k] = src

    }
        
    trg_check_column_value (table, name) {
    
    	let sql = ''

			let col = table.columns [name]
			
			if (col) {
			
				if (col.MIN)        sql += this.trg_check_column_value_min        (col, table)
				if (col.MAX)        sql += this.trg_check_column_value_max        (col, table)
				if (col.MIN_LENGTH) sql += this.trg_check_column_value_min_length (col, table)
				if (col.PATTERN)    sql += this.trg_check_column_value_pattern    (col, table)			
			
			}
			else {
			
				darn (`trg_check_column_value: column ${table.name}.${name} not found`)
			
			}

    	return sql

    }

    trg_check_column_value_min (col, table) {
    
    	let type = col.TYPE_NAME.toUpperCase ()
    
    	if (/(INT|NUM|DEC)/.test (type)) return this.trg_check_column_value_min_num (col, table)
    	if (/(DATE|TIME)/.test (type)) return this.trg_check_column_value_min_date (col, table)
    	
		throw `Can't check MIN condition for ${type} type: ${table.name}.${col.name}`
    	
    }

    trg_check_column_value_max (col, table) {
    
    	let type = col.TYPE_NAME.toUpperCase ()
    
    	if (/(INT|NUM|DEC)/.test (type)) return this.trg_check_column_value_max_num (col, table)
    	if (/(DATE|TIME)/.test (type)) return this.trg_check_column_value_max_date (col, table)
    	
		throw `Can't check MAX condition for ${type} type: ${table.name}.${col.name}`
    	
    }

    trg_check_column_value_min_num (col, table) {return `
		IF NEW.${col.name} IS NOT NULL AND NEW.${col.name} < ${col.MIN} THEN
			RAISE '#${col.name}#: ${table.model.trg_check_column_value_min_num (col, table)}';
		END IF;
    `}

    trg_check_column_value_min_date (col, table) {return `
		IF NEW.${col.name} IS NOT NULL AND NEW.${col.name} < '${col.MIN}' THEN
			RAISE '#${col.name}#: ${table.model.trg_check_column_value_min_date (col, table)}';
		END IF;
    `}

    trg_check_column_value_max_num (col, table) {return `
		IF NEW.${col.name} IS NOT NULL AND NEW.${col.name} > ${col.MAX} THEN
			RAISE '#${col.name}#: ${table.model.trg_check_column_value_max_num (col, table)}';
		END IF;
    `}

    trg_check_column_value_max_date (col, table) {
    
    	let v = `'${col.MAX}'`; if (v == "'NOW'") v = 'now()'

		return `
			IF NEW.${col.name} IS NOT NULL AND NEW.${col.name} > '${v}' THEN
				RAISE '#${col.name}#: ${table.model.trg_check_column_value_max_date (col, table)}';
			END IF;
		`

    }
    
    trg_check_column_value_min_length (col, table) {return `
		IF NEW.${col.name} IS NOT NULL AND LENGTH (NEW.${col.name}) < ${col.MIN_LENGTH} THEN
			RAISE '#${col.name}#: ${table.model.trg_check_column_value_min_length (col, table)}';
		END IF;
    `}

    trg_check_column_value_pattern (col, table) {return `
		IF NEW.${col.name} IS NOT NULL AND NEW.${col.name}::text !~ '${col.PATTERN}' THEN
			RAISE '#${col.name}#: ${table.model.trg_check_column_value_pattern (col, table)}';
		END IF;
	`}
    
    normalize_model_table_column (table, col) {
        
        super.normalize_model_table_column (table, col) 
        
        function get_int_type_name (prefix) {switch (prefix) {
            case 'MEDIUM': 
            case 'BIG': 
                return 'INT8'
            case 'SMALL': 
            case 'TINY':
                return 'INT2'
            default: 
                return 'INT4'
        }}
        
        if (/INT$/.test (col.TYPE_NAME)) {
            col.TYPE_NAME = get_int_type_name (col.TYPE_NAME.substr (0, col.TYPE_NAME.length - 3))
        }
        else if (/(RCHAR|STRING|TEXT)$/.test (col.TYPE_NAME)) {
            col.TYPE_NAME = col.COLUMN_SIZE ? 'VARCHAR' : 'TEXT'
        }
        else if (/BINARY$/.test (col.TYPE_NAME)) {
            col.TYPE_NAME = 'BYTEA'
        }
        else if (/BLOB$/.test (col.TYPE_NAME)) {
            col.TYPE_NAME = 'OID'
        }
        else if (col.TYPE_NAME == 'DECIMAL' || col.TYPE_NAME == 'MONEY' || col.TYPE_NAME == 'NUMBER') {
            col.TYPE_NAME = 'NUMERIC'
        }
        else if (col.TYPE_NAME == 'DATETIME') {
            col.TYPE_NAME = 'TIMESTAMP'
        }
        else if (col.TYPE_NAME == 'CHECKBOX') {
            col.TYPE_NAME = 'INT2'
            col.COLUMN_DEF = '0'
        }
        
        if (col.TYPE_NAME == 'NUMERIC') {
            if (!col.COLUMN_SIZE) col.COLUMN_SIZE = 10
            if (col.DECIMAL_DIGITS == undefined) col.DECIMAL_DIGITS = 0
        }                
        
    }
    
    gen_sql_recreate_foreign_tables () {

        let result = []

        for (let {name, label, db_link, columns} of Object.values (this.model.foreign_tables)) {
        
        	for (let [foreign_server, options] of Object.entries (db_link)) {

				result.push ({sql: `DROP FOREIGN TABLE IF EXISTS "${name}" CASCADE`, params: []})

				result.push ({sql: `CREATE FOREIGN TABLE "${name}" (${Object.values (columns).map (col => col.name + ' ' + this.gen_sql_column_definition (col))}) SERVER ${foreign_server} OPTIONS (${Object.entries (options).map (i => `${i[0]} '${i[1]}'`)})`, params: []})

				result.push ({sql: `COMMENT ON FOREIGN TABLE "${name}" IS ` + this.gen_sql_quoted_literal (label), params: []})

        	}
        	
        }
        
        if (result.length) for (let view of Object.values (this.model.views)) delete view._no_recreate

        return result

    }    
    
    gen_sql_recreate_proc () {

        let result = []
        
        for (let type of ['function', 'procedure']) {
        
        	let is_fun = type == 'function'
        
			for (let {name, returns, arg, declare, body, label, existing} of Object.values (this.model [type + 's'])) {

				function vars (o, t = '') {return !o ? '' : Object.entries (o).map (i => i [0] + ' ' + i [1] + t)}

				let src = (!declare ? '' : 'DECLARE ' + vars (declare, ';').join ('')) + `BEGIN ${body} END;`

				if (existing && existing.src == src) continue

				name += '(' + vars (arg) + ')'

				result.push ({sql: `DROP ${type} IF EXISTS ${name}`, params: []})

				let sql = `CREATE ${type} ${name}`

				if (is_fun) sql += ' RETURNS ' + returns

				sql += ` AS $$${src}$$ LANGUAGE plpgsql`

				result.push ({sql, params: []})

				if (is_fun) result.push ({sql: `COMMENT ON ${type} ${name} IS ` + this.gen_sql_quoted_literal (label), params: []})

			}
			
		}

        return result

    }

}