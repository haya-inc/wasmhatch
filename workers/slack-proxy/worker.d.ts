declare const worker: {
  fetch(request: Request, env?: { ALLOWED_ORIGIN?: string }): Promise<Response>;
};

export default worker;
