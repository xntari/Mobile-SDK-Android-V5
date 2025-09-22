package dji.sampleV5.aircraft.data

import kotlin.math.*

/**
 * Regional Geoid Model for WGS-84 to MSL conversion
 *
 * This class provides geoid height (undulation) values to convert between
 * WGS-84 ellipsoid heights and Mean Sea Level (MSL) altitudes.
 *
 * Formula: h_MSL = h_ellipsoid - N
 * where N is the geoid height (positive when geoid is above ellipsoid)
 *
 * IMPORTANT: This is a simplified regional model optimized for California/West Coast USA.
 * For global coverage and higher accuracy, integrate actual EGM96/EGM2008/GEOID18 data from:
 * - NGA: https://earth-info.nga.mil/
 * - NOAA: https://www.ngs.noaa.gov/GEOID/
 * - Or use GeographicLib: https://geographiclib.sourceforge.io/
 *
 * Based on actual EGM96/GEOID18 values for California region:
 * - San Francisco Bay Area (37°N, -122°W): -31.719m (GEOID18)
 * - Los Angeles Area (34°N, -118°W): -32.884m (GEOID18)
 * - San Diego Area (32.7°N, -117°W): -31.391m (GEOID18)
 * - Sacramento (38.5°N, -121.5°W): -30.256m (GEOID18)
 * - Fresno (36.7°N, -119.8°W): -31.852m (GEOID18)
 */
object GeoidModel {

    /**
     * Get the geoid height (undulation) at a given location
     *
     * This implementation uses a simple regional model for California.
     * The geoid separation in California ranges from approximately -30m to -34m.
     *
     * @param latitude Latitude in decimal degrees (-90 to 90)
     * @param longitude Longitude in decimal degrees (-180 to 180)
     * @return Geoid height in meters (negative in California - geoid below ellipsoid)
     */
    fun getGeoidHeight(latitude: Double, longitude: Double): Double {
        // For California region (approximate boundaries)
        if (latitude in 32.0..42.0 && longitude in -125.0..-114.0) {
            // Use a simple planar approximation based on known values
            // The geoid in California has a gentle slope from north to south
            // and from west to east

            // Base value at center of California (37°N, -120°W)
            val baseGeoid = -31.8

            // Latitude gradient: ~0.15m per degree (south is more negative)
            val latGradient = (latitude - 37.0) * 0.15

            // Longitude gradient: ~0.05m per degree (east is slightly less negative)
            val lonGradient = (longitude + 120.0) * 0.05

            // Apply corrections
            val geoidHeight = baseGeoid - latGradient + lonGradient

            // Clamp to reasonable range for California
            return geoidHeight.coerceIn(-34.0, -29.0)
        }

        // For other regions, return a default or throw an exception
        // This is a regional model, not global

        // Western US approximate values
        if (latitude in 25.0..49.0 && longitude in -130.0..-100.0) {
            // Rough approximation for broader western US
            return -30.0 - (35.0 - latitude) * 0.3
        }

        // Outside supported region - return 0 or throw exception
        // In production, you'd want to use actual global geoid data
        return 0.0  // WARNING: This is not accurate outside California/Western US
    }

    /**
     * Convert WGS-84 ellipsoid height to Mean Sea Level altitude
     *
     * @param ellipsoidHeight Height above WGS-84 ellipsoid in meters
     * @param latitude Latitude in decimal degrees
     * @param longitude Longitude in decimal degrees
     * @return Altitude above mean sea level in meters
     */
    fun ellipsoidToMSL(ellipsoidHeight: Double, latitude: Double, longitude: Double): Double {
        val geoidHeight = getGeoidHeight(latitude, longitude)
        // MSL = Ellipsoid - Geoid
        // In California, geoid is negative (below ellipsoid), so we add its absolute value
        return ellipsoidHeight - geoidHeight
    }

    /**
     * Convert Mean Sea Level altitude to WGS-84 ellipsoid height
     *
     * @param mslAltitude Altitude above mean sea level in meters
     * @param latitude Latitude in decimal degrees
     * @param longitude Longitude in decimal degrees
     * @return Height above WGS-84 ellipsoid in meters
     */
    fun mslToEllipsoid(mslAltitude: Double, latitude: Double, longitude: Double): Double {
        val geoidHeight = getGeoidHeight(latitude, longitude)
        // Ellipsoid = MSL + Geoid
        return mslAltitude + geoidHeight
    }
}