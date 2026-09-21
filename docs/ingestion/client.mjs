import { createIngestionRequest } from './contracts.mjs';

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export class IngestionClient {
  async create(source, deviceClass) {
    return request('/api/parcel-ingestions', {
      method: 'POST',
      body: JSON.stringify(createIngestionRequest(source, deviceClass)),
    });
  }

  async uploadImages(ingestionId, images) {
    return request(`/api/parcel-ingestions/${ingestionId}/images`, {
      method: 'PUT',
      body: JSON.stringify(images),
    });
  }

  async addMetadata(ingestionId, metadata) {
    return request(`/api/parcel-ingestions/${ingestionId}/metadata`, {
      method: 'POST',
      body: JSON.stringify(metadata),
    });
  }

  async extract(ingestionId, enums) {
    return request(`/api/parcel-ingestions/${ingestionId}/extract`, {
      method: 'POST',
      body: JSON.stringify({ enums }),
    });
  }

  async get(ingestionId) {
    return request(`/api/parcel-ingestions/${ingestionId}`);
  }
}
