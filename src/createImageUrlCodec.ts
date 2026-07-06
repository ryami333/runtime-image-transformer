import z from "zod";
import { transformConfigSchema } from "./transformConfigSchema";
import { searchParamsToTransformConfigCodec } from "./searchParamsToTransformConfigCodec";

export const createImageUrlCodec = ({
  apiRouteUrl,
}: {
  /**
   * The transform route. Usually a root-relative path like `"/api/image"`, in
   * which case the builder emits root-relative URLs and no origin needs to be
   * known at build time. An absolute URL (e.g. a CDN-hosted route) also works.
   */
  apiRouteUrl: string;
}) => {
  return z.codec(z.string(), transformConfigSchema, {
    encode: (input) => {
      const query = searchParamsToTransformConfigCodec.encode(input).toString();

      // Support both absolute (`https://cdn/x`) and root-relative (`/api/image`)
      // routes. `new URL` throws on a relative string, which is our signal to
      // assemble the URL by hand and keep it relative.
      try {
        const url = new URL(apiRouteUrl);
        url.search = query;
        return url.toString();
      } catch {
        return query ? `${apiRouteUrl}?${query}` : apiRouteUrl;
      }
    },
    decode: (input) => {
      // A dummy base lets `URL` parse root-relative inputs too; we only read the
      // search params, so the base is irrelevant.
      const url = new URL(input, "http://localhost");
      return searchParamsToTransformConfigCodec.decode(url.searchParams);
    },
  });
};
