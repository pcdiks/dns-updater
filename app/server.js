const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const { DnsManagementClient } = require('@azure/arm-dns');
const { ClientSecretCredential } = require('@azure/identity');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_FILE = '/data/config.json';
const IP_CACHE_FILE = '/data/last_ip.txt';
const IP_HISTORY_FILE = '/data/ip_history.json';

// ── In-memory log ring buffer ─────────────────────────────────────────────────
const LOG_MAX = 300;
const logBuffer = [];

function addLog(level, args) {
  const message = args.map(a =>
    typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
  ).join(' ');
  logBuffer.unshift({ ts: new Date().toISOString(), level, message });
  if (logBuffer.length > LOG_MAX) logBuffer.pop();
}

const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);
console.log   = (...a) => { _origLog(...a);   addLog('info',  a); };
console.warn  = (...a) => { _origWarn(...a);  addLog('warn',  a); };
console.error = (...a) => { _origError(...a); addLog('error', a); };
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static('public'));

// Initialize config
let config = {
  providers: [],
  records: [],
  checkInterval: '*/5 * * * *' // Every 5 minutes
};

// Load configuration
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    config = JSON.parse(data);
    console.log('[system] Configuration loaded');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[system] No existing configuration, starting fresh');
      await saveConfig();
    } else {
      console.error('[system] Error loading config:', error);
    }
  }
}

// Save configuration
async function saveConfig() {
  try {
    await fs.mkdir('/data', { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('[system] Configuration saved');
  } catch (error) {
    console.error('[system] Error saving config:', error);
  }
}

// Get current public IP
async function getCurrentIP() {
  const services = [
    'https://api.ipify.org?format=json',
    'https://api4.my-ip.io/v2/ip.json',
    'https://ipv4.icanhazip.com'
  ];
  for (const url of services) {
    try {
      const response = await axios.get(url, { timeout: 5000 });
      const ip = response.data.ip || response.data.trim();
      if (ip) return ip;
    } catch (_) {
      // try next service
    }
  }
  console.error('[system] Error getting public IP: all services failed');
  return null;
}

// Get last known IP
async function getLastIP() {
  try {
    return (await fs.readFile(IP_CACHE_FILE, 'utf8')).trim();
  } catch (error) {
    return null;
  }
}

// Save current IP
async function saveCurrentIP(ip) {
  try {
    await fs.mkdir('/data', { recursive: true });
    await fs.writeFile(IP_CACHE_FILE, ip);
  } catch (error) {
    console.error('[system] Error saving IP:', error);
  }
}

// Append an entry to the IP history log
async function appendIPHistory(oldIp, newIp) {
  try {
    await fs.mkdir('/data', { recursive: true });
    let history = [];
    try {
      history = JSON.parse(await fs.readFile(IP_HISTORY_FILE, 'utf8'));
    } catch (_) {}
    history.unshift({ timestamp: new Date().toISOString(), oldIp: oldIp || null, newIp });
    // Keep last 500 entries
    if (history.length > 500) history = history.slice(0, 500);
    await fs.writeFile(IP_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error('[system] Error saving IP history:', error);
  }
}

// Update Azure DNS record
async function updateAzureDNS(provider, record, ipAddress) {
  try {
    const credential = new ClientSecretCredential(
      provider.tenantId,
      provider.clientId,
      provider.clientSecret
    );
    
    const client = new DnsManagementClient(credential, provider.subscriptionId);
    
    const recordSet = {
      ttl: record.ttl || 3600,
      aRecords: [{ ipv4Address: ipAddress }]
    };
    
    await client.recordSets.createOrUpdate(
      provider.resourceGroup,
      provider.zoneName,
      record.name,
      'A',
      recordSet
    );
    
    console.log(`[azure] Updated ${record.name}.${provider.zoneName} -> ${ipAddress}`);
    return { success: true };
  } catch (error) {
    console.error(`[azure] Error updating ${record.name}.${provider.zoneName}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Update Cloudflare DNS record
async function updateCloudflareDNS(provider, record, ipAddress) {
  try {
    const headers = {
      'Authorization': `Bearer ${provider.apiToken}`,
      'Content-Type': 'application/json'
    };

    const zoneId = provider.zoneId;
    if (!zoneId) {
      throw new Error('Cloudflare Zone ID is not configured for this provider');
    }

    // Get existing record
    const recordsResponse = await axios.get(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${record.name}.${provider.zoneName}`,
      { headers }
    );
    
    const recordData = {
      type: 'A',
      name: record.name,
      content: ipAddress,
      ttl: record.ttl || 3600,
      proxied: record.proxied || false
    };
    
    if (recordsResponse.data.result.length > 0) {
      // Update existing record
      const recordId = recordsResponse.data.result[0].id;
      await axios.put(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
        recordData,
        { headers }
      );
    } else {
      // Create new record
      await axios.post(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
        recordData,
        { headers }
      );
    }
    
    console.log(`[cloudflare] Updated ${record.name}.${provider.zoneName} -> ${ipAddress}`);
    return { success: true };
  } catch (error) {
    console.error(`[cloudflare] Error updating ${record.name}.${provider.zoneName}: ${error.response?.data?.errors ? JSON.stringify(error.response.data.errors) : error.message}`);
    return { success: false, error: error.response?.data?.errors || error.message };
  }
}

// Update all DNS records
async function updateAllRecords(forceUpdate = false) {
  const currentIP = await getCurrentIP();
  if (!currentIP) {
    console.error('[system] Could not determine current IP');
    return { success: false, message: 'Could not determine current IP' };
  }
  
  const lastIP = await getLastIP();
  
  if (!forceUpdate && currentIP === lastIP) {
    console.log(`[system] IP unchanged: ${currentIP}`);
    return { success: true, message: 'IP unchanged', ip: currentIP };
  }
  
  console.log(`[system] IP changed: ${lastIP} -> ${currentIP}`);
  
  const results = [];
  
  for (const record of config.records) {
    if (!record.enabled) {
      continue;
    }
    
    const provider = config.providers.find(p => p.id === record.providerId);
    if (!provider) {
      console.error(`[system] Provider not found for record: ${record.name}`);
      continue;
    }
    
    let result;
    if (provider.type === 'azure') {
      result = await updateAzureDNS(provider, record, currentIP);
    } else if (provider.type === 'cloudflare') {
      result = await updateCloudflareDNS(provider, record, currentIP);
    }
    
    results.push({
      record: `${record.name}.${provider.zoneName}`,
      ...result
    });
  }
  
  await saveCurrentIP(currentIP);
  await appendIPHistory(lastIP, currentIP);

  return {
    success: true,
    message: 'DNS records updated',
    ip: currentIP,
    oldIp: lastIP,
    results
  };
}

// API Routes

// Get current configuration
app.get('/api/config', async (req, res) => {
  // Don't send sensitive credentials to client
  const sanitizedConfig = {
    ...config,
    providers: config.providers.map(p => ({
      ...p,
      clientSecret: p.clientSecret ? '***' : undefined,
      apiToken: p.apiToken ? '***' : undefined
    }))
  };
  res.json(sanitizedConfig);
});

// Get IP history
app.get('/api/ip-history', async (req, res) => {
  try {
    const history = JSON.parse(await fs.readFile(IP_HISTORY_FILE, 'utf8'));
    res.json({ success: true, history });
  } catch (_) {
    res.json({ success: true, history: [] });
  }
});

// Get logs
app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, LOG_MAX);
  res.json({ success: true, logs: logBuffer.slice(0, limit) });
});

// Get current IP status
app.get('/api/status', async (req, res) => {
  const currentIP = await getCurrentIP();
  const lastIP = await getLastIP();
  res.json({
    currentIP,
    lastIP,
    changed: currentIP !== lastIP
  });
});

// Add or update provider
app.post('/api/providers', async (req, res) => {
  const provider = req.body;
  
  if (!provider.id) {
    provider.id = Date.now().toString();
  }
  
  const index = config.providers.findIndex(p => p.id === provider.id);
  if (index >= 0) {
    // Keep existing secrets if not provided
    if (provider.clientSecret === '***') {
      provider.clientSecret = config.providers[index].clientSecret;
    }
    if (provider.apiToken === '***') {
      provider.apiToken = config.providers[index].apiToken;
    }
    config.providers[index] = provider;
  } else {
    config.providers.push(provider);
  }
  
  await saveConfig();
  res.json({ success: true, provider: { ...provider, clientSecret: '***', apiToken: '***' } });
});

// Delete provider
app.delete('/api/providers/:id', async (req, res) => {
  const { id } = req.params;
  config.providers = config.providers.filter(p => p.id !== id);
  config.records = config.records.filter(r => r.providerId !== id);
  await saveConfig();
  res.json({ success: true });
});

// Add or update DNS record
app.post('/api/records', async (req, res) => {
  const record = req.body;

  const isNew = !record.id;
  if (isNew) {
    record.id = Date.now().toString();
  }

  const index = config.records.findIndex(r => r.id === record.id);
  if (index >= 0) {
    config.records[index] = record;
  } else {
    config.records.push(record);
  }

  await saveConfig();

  // For new or edited enabled records, immediately write the current IP to the DNS provider
  // so changes appear right away without waiting for the next cron tick.
  let syncResult = null;
  if (record.enabled) {
    const provider = config.providers.find(p => p.id === record.providerId);
    if (provider) {
      const currentIP = await getCurrentIP();
      if (currentIP) {
        if (provider.type === 'azure') {
          syncResult = await updateAzureDNS(provider, record, currentIP);
        } else if (provider.type === 'cloudflare') {
          syncResult = await updateCloudflareDNS(provider, record, currentIP);
        }
        console.log(`[${provider.type}] DNS sync for ${isNew ? 'new' : 'edited'} record ${record.name}.${provider.zoneName}: ${syncResult?.success ? 'OK' : syncResult?.error}`);
      }
    }
  }

  res.json({ success: true, record, syncResult });
});

// Delete an A record from Azure DNS
async function deleteAzureDNS(provider, record) {
  const credential = new ClientSecretCredential(
    provider.tenantId,
    provider.clientId,
    provider.clientSecret
  );
  const client = new DnsManagementClient(credential, provider.subscriptionId);
  await client.recordSets.delete(
    provider.resourceGroup,
    provider.zoneName,
    record.name,
    'A'
  );
}

// Delete an A record from Cloudflare
async function deleteCloudflareDNS(provider, record) {
  const headers = {
    'Authorization': `Bearer ${provider.apiToken}`,
    'Content-Type': 'application/json'
  };

  const zoneId = provider.zoneId;
  if (!zoneId) {
    throw new Error('Cloudflare Zone ID is not configured for this provider');
  }

  const recordsResponse = await axios.get(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${record.name}.${provider.zoneName}`,
    { headers }
  );
  if (recordsResponse.data.result.length === 0) {
    throw new Error(`Record ${record.name} not found in Cloudflare zone`);
  }
  const recordId = recordsResponse.data.result[0].id;
  await axios.delete(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
    { headers }
  );
}

// Delete DNS record (optionally also from the provider)
app.delete('/api/records/:id', async (req, res) => {
  const { id } = req.params;
  const deleteFromProvider = req.query.deleteFromProvider === 'true';

  const record = config.records.find(r => r.id === id);
  if (!record) {
    return res.status(404).json({ success: false, error: 'Record not found' });
  }

  if (deleteFromProvider) {
    const provider = config.providers.find(p => p.id === record.providerId);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Provider not found' });
    }
    try {
      if (provider.type === 'azure') {
        await deleteAzureDNS(provider, record);
      } else if (provider.type === 'cloudflare') {
        await deleteCloudflareDNS(provider, record);
      }
    } catch (error) {
      console.error(`[${provider.type}] Error deleting ${record.name}.${provider.zoneName}: ${error.message}`);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  config.records = config.records.filter(r => r.id !== id);
  await saveConfig();
  res.json({ success: true });
});

// Scan Azure DNS zone for existing A records
async function scanAzureZone(provider) {
  const credential = new ClientSecretCredential(
    provider.tenantId,
    provider.clientId,
    provider.clientSecret
  );
  const client = new DnsManagementClient(credential, provider.subscriptionId);
  const records = [];
  for await (const recordSet of client.recordSets.listByType(
    provider.resourceGroup,
    provider.zoneName,
    'A'
  )) {
    records.push({
      name: recordSet.name,
      ttl: recordSet.ttl,
      currentIp: recordSet.aRecords?.[0]?.ipv4Address || null
    });
  }
  return records;
}

// Scan Cloudflare zone for existing A records
async function scanCloudflareZone(provider) {
  const headers = {
    'Authorization': `Bearer ${provider.apiToken}`,
    'Content-Type': 'application/json'
  };

  const zoneId = provider.zoneId;
  if (!zoneId) {
    throw new Error('Cloudflare Zone ID is not configured for this provider');
  }

  const records = [];
  let page = 1;
  while (true) {
    const response = await axios.get(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&per_page=100&page=${page}`,
      { headers }
    );
    for (const r of response.data.result) {
      records.push({
        name: r.name.replace(`.${provider.zoneName}`, '').replace(provider.zoneName, '@'),
        ttl: r.ttl === 1 ? 3600 : r.ttl,
        proxied: r.proxied,
        currentIp: r.content
      });
    }
    if (page >= response.data.result_info.total_pages) break;
    page++;
  }
  return records;
}

// Scan a provider's zone for A records
app.get('/api/providers/:id/scan', async (req, res) => {
  const provider = config.providers.find(p => p.id === req.params.id);
  if (!provider) {
    return res.status(404).json({ success: false, error: 'Provider not found' });
  }
  try {
    let found;
    if (provider.type === 'azure') {
      found = await scanAzureZone(provider);
    } else if (provider.type === 'cloudflare') {
      found = await scanCloudflareZone(provider);
    } else {
      return res.status(400).json({ success: false, error: 'Unknown provider type' });
    }

    // Mark which records are already tracked
    const tracked = new Set(
      config.records
        .filter(r => r.providerId === provider.id)
        .map(r => r.name)
    );
    const result = found.map(r => ({ ...r, alreadyTracked: tracked.has(r.name) }));
    res.json({ success: true, records: result });
  } catch (error) {
    console.error('[system] Error scanning zone:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trigger manual update
app.post('/api/update', async (req, res) => {
  const result = await updateAllRecords(true);
  res.json(result);
});

// Update check interval
app.post('/api/interval', async (req, res) => {
  const { interval } = req.body;
  config.checkInterval = interval;
  await saveConfig();
  setupCron();
  res.json({ success: true });
});

// Setup cron job
let cronJob = null;

function setupCron() {
  if (cronJob) {
    cronJob.stop();
  }
  
  cronJob = cron.schedule(config.checkInterval, () => {
    console.log('[system] Running scheduled DNS update check...');
    updateAllRecords(false);
  });
  
  console.log(`[system] Cron job scheduled: ${config.checkInterval}`);
}

// Initialize and start server
async function start() {
  await loadConfig();
  setupCron();
  
  app.listen(PORT, () => {
    console.log(`[system] DNS Updater running on port ${PORT}`);
    console.log(`[system] Web GUI: http://localhost:${PORT}`);
  });
}

start();
