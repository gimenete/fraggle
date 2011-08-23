var fs = require('fs')
var path = require('path')
var child_process = require('child_process')
var sys = require('sys')
require('colors')
var ejs = require('ejs')

var basePath = process.env.FRAGGLE_BASE_PATH || process.cwd()
var repos = path.join(basePath, 'repos')
var logs = path.join(basePath, 'logs')
var conf = path.join(basePath, 'config.json')
var cfg = path.join(basePath, 'haproxy.cfg')
var minport = 9000

function availablePort(config) {
	var p = minport
	while(!isAvailable(config, p)) {
		p++
	}
	return p
}

function isAvailable(config, p) {
	for (var key in config) {
		var running = config[key].running
		if (!running) {
			continue
		}
		
		for (var subdomain in running) {
			var port = running[subdomain].port
			if (port === p) {
				return false
			}
		}
	}
	return true
}

function execAndPrint(command, args, options, callback) {
	var proc = child_process.spawn(command, args, options)
	
	proc.stdout.on('data', function (data) {
		process.stdout.write(data)
	})

	proc.stderr.on('data', function (data) {
		process.stderr.write(data)
	})

	proc.on('exit', function (code) {
		if (code !== 0) {
			callback([command, args.join(' '), 'exited with code', code].join(' '))
		} else {
			callback(null)
		}
	})
}

function createDirectories(callback) {
	createPath(repos, function() {
		createPath(logs, function() {
			callback()
		})
	})
}

function createPath(p, callback) {
	path.exists(p, function(exists) {
		if (!exists) {
			fs.mkdir(p, "0755", function() {
				callback()
				return
			})
		} else {
			callback()
		}
	})
}

function findSubdomain(config, subdomain) {
	for (var key in config) {
		var i = subdomain.indexOf(key)
		if (i > 1 && subdomain.charAt(i-1) === '.' && subdomain.length === i + key.length) {
			return {domain:key, tag:subdomain.substring(0, i-1)}
		}
	}
	return {}
}

var actions = {

	'add': function(config, callback) {
		var domain = process.argv[3]
		var repo = process.argv[4]
		var executable = process.argv[5]
		
		if (!domain || !repo || !executable) {
			console.log('Usage: add <domain> <repo> <executable>')
			callback(false, false)
		} else {
			// TODO: if already exists
			config[domain] = {repo:repo, executable:executable}
			callback(true, true)
		}
	},
	
	'deploy': function(config, callback) {
		var subdomain = process.argv[3]
		var port = availablePort(config)
		
		if (!subdomain) {
			console.log('Usage: deploy <tag>.<domain>')
			callback(false, false)
			return
		} else {
			var info = findSubdomain(config, subdomain)
			var domain = info.domain
			var tag = info.tag
			
			if (!domain || !tag) {
				console.log('Service not found. Use <add> first')
				callback(false, false)
				return
			} else if (!config[domain].executable || !config[domain].repo) {
				console.log('Invalid config for', domain, 'no executable or no repo found')
				callback(false, false)
				return
			} else {
				var repo = config[domain].repo
				var executable = config[domain].executable
				var args = null
				
				if (repo.indexOf('git@') === 0) {
					command = 'git'
					args = ['clone', repo, path.join(repos, subdomain)]
				} else {
					console.log('Unknown repo type', repo)
					callback(false, false)
					return
				}
				
				createDirectories(function() {
					console.log('Downloading project')
					execAndPrint(command, args, null, function(error) {
						if (error) {
							console.log(error)
							callback(false, false)
							return
						}
						console.log('Project downloaded')
						
						if (repo.indexOf('git@') === 0) {
							command = 'git'
							args = ['checkout', tag]
						}
						console.log('Changing repo to version', tag)
						execAndPrint(command, args, {cwd: path.join(repos, subdomain)}, function(error) {
							if (error) {
								console.log(error)
								callback(false, false)
								return
							}
							console.log('Changed to version', tag)
							
							command = 'forever'
							args = ['start', '-a',
								'-l', path.join(logs, subdomain+'_l.txt'),
								'-o', path.join(logs, subdomain+'_o.txt'),
								'-e', path.join(logs, subdomain+'_e.txt'),
								path.join(subdomain, executable),
								port
							]
							
							execAndPrint(command, args, {cwd: repos}, function(error) {
								if (error) {
									console.log(error)
									callback(false, false)
									return
								}
								
								var running = config[domain].running || {}
								running[subdomain] = { port:port }
								config[domain].running = running
								
								console.log('Service started')
								callback(true, true)
							})
						})
					})
				})
			}
		}
		
	},
	
	'delete': function(config, callback) {
		var subdomain = process.argv[3]
		var port = availablePort(config)
		
		if (!subdomain) {
			console.log('Usage: delete <tag>.<domain>')
			callback(false, false)
			return
		} else {
			var info = findSubdomain(config, subdomain)
			var domain = info.domain
			var tag = info.tag
			
			if (!domain || !tag) {
				console.log('Service not found. Use <add> first')
				callback(false, false)
				return
			} else if (!config[domain].executable) {
				console.log('Invalid config for', domain, 'no executable found')
				callback(false, false)
				return
			}
			
			var executable = config[domain].executable
			
			var command = 'forever'
			var args = ['stop', path.join(subdomain, executable)]
			execAndPrint(command, args, {cwd: repos}, function(error) {
				if (error) {
					console.log(error)
					callback(false, false)
					return
				}
				
				var command = 'rm'
				var args = ['-rf', path.join(repos, subdomain)]
				execAndPrint(command, args, null, function(error) {
					if (error) {
						console.log(error)
						callback(false, false)
						return
					}
					
					var running = config[domain].running || {}
					delete running[subdomain]
					config[domain].running = running
					
					callback(true, true)
				})
				
			})
		}
	},
	
	'list': function(config, callback) {
		for (var key in config) {
			sys.puts(key.green)
			
			var running = config[key].running
			if (!running) {
				sys.puts('No running processes')
			} else {
				for (var subdomain in running) {
					var info = running[subdomain]
					console.log(subdomain.blue, (info.port+'').magenta, running[subdomain].prod ? 'PROD' : '')
				}
			}
		}
		callback(false, false)
	},
	
	'default': function(config, callback) {
		var subdomain = process.argv[3]
		var port = availablePort(config)
		
		if (!subdomain) {
			console.log('Usage: default <tag>.<domain>')
			callback(false, false)
			return
		} else {
			var info = findSubdomain(config, subdomain)
			var domain = info.domain
			var tag = info.tag
			
			if (!domain || !tag) {
				console.log('Service not found. Use <add> first')
				callback(false, false)
				return
			} else if (!config[domain].running || !config[domain].running[subdomain]) {
				console.log('Service not running. Use <deploy> first')
				callback(false, false)
				return
			} else {
				var running = config[domain].running
				for (var sub in running) {
					delete running[sub].prod
				}
				
				config[domain].running[subdomain].prod = true
				callback(true, true)
			}
		}
	}
	
}

var action = process.argv[2]

if (!action) {
	console.log('Must pass an action')
} else {
	var f = actions[action]
	
	if (!f) {
		console.log('Unknown action', action)
	} else {
		
		var services = fs.readFile(conf, 'utf8', function(err, data) {
			if (err) {
				console.log(err)
			}
			
			if (data) {
				try {
					data = JSON.parse(data)
				} catch(e) {
					console.log(data)
					console.log('Error parsing data')
				}
			}
			data = data || {}
			f(data, function(requires_config_save, requires_proxy_restart) {
				
				if (requires_config_save) {
					fs.writeFile(conf, JSON.stringify(data), function(err) {
						console.log('Config saved')
					})
				}
				
				if (requires_proxy_restart) {
					fs.readFile('haproxy.ejs', 'utf8', function(err, template) {
						if (err) {
							console.log('Error reading haproxy.ejs')
							return
						}
						
						var out = ejs.render(template, {locals:{data:data}})
						
						fs.writeFile(cfg, out, function(err) {
							if (err) {
								console.log('Error writing configuration file')
								return
							}
							
							fs.readFile('/var/run/haproxy.pid', 'ascii', function(err, content) {
								var args = null
								if (err) {
									var args = ['/usr/local/sbin/haproxy', '-f', cfg, '-p', '/var/run/haproxy.pid', '-sf']
								} else {
									var args = ['/usr/local/sbin/haproxy', '-f', cfg, '-p', '/var/run/haproxy.pid', '-sf', content]
								}
								
								var command = 'sudo'
								
								execAndPrint(command, args, null, function(error) {
									if (error) {
										console.log(error)
									} else {
										console.log('HAProxy restarted')
									}
								})
							})
							
						})
					})
				}
				
			})
			
		})
	}
}