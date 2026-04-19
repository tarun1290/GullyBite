// src/utils/pincodeCityMap.js
// 3-digit pincode prefix → { city, state } lookup used to tag
// serviceable_pincodes documents. The map is intentionally coarse —
// it groups PINs by metropolitan area, not by sub-district. Unknown
// prefixes return { city: 'Other', state: 'Other' } so the aggregation
// endpoint still has something to group on.

'use strict';

// Order is significant only for readability — prefixes are all disjoint.
const ENTRIES = [
  ['110', 'Delhi', 'Delhi'],
  ['121', 'Faridabad', 'Haryana'],
  ['122', 'Gurugram', 'Haryana'],
  ['131', 'Sonipat', 'Haryana'],
  ['132', 'Karnal', 'Haryana'],
  ['134', 'Panchkula', 'Haryana'],
  ['140', 'Mohali', 'Punjab'],
  ['141', 'Ludhiana', 'Punjab'],
  ['142', 'Moga', 'Punjab'],
  ['143', 'Amritsar', 'Punjab'],
  ['144', 'Jalandhar', 'Punjab'],
  ['147', 'Patiala', 'Punjab'],
  ['160', 'Chandigarh', 'Chandigarh'],
  ['201', 'Noida / Greater Noida', 'Uttar Pradesh'],
  ['202', 'Etah', 'Uttar Pradesh'],
  ['203', 'Farrukhabad', 'Uttar Pradesh'],
  ['208', 'Kanpur', 'Uttar Pradesh'],
  ['211', 'Prayagraj', 'Uttar Pradesh'],
  ['221', 'Varanasi', 'Uttar Pradesh'],
  ['226', 'Lucknow', 'Uttar Pradesh'],
  ['248', 'Dehradun', 'Uttarakhand'],
  ['282', 'Agra', 'Uttar Pradesh'],
  ['302', 'Jaipur', 'Rajasthan'],
  ['303', 'Jaipur', 'Rajasthan'],
  ['305', 'Ajmer', 'Rajasthan'],
  ['332', 'Sikar', 'Rajasthan'],
  ['360', 'Rajkot', 'Gujarat'],
  ['380', 'Ahmedabad', 'Gujarat'],
  ['382', 'Ahmedabad', 'Gujarat'],
  ['388', 'Anand', 'Gujarat'],
  ['390', 'Vadodara', 'Gujarat'],
  ['395', 'Surat', 'Gujarat'],
  ['400', 'Mumbai', 'Maharashtra'],
  ['401', 'Palghar / Vasai', 'Maharashtra'],
  ['410', 'Navi Mumbai', 'Maharashtra'],
  ['411', 'Pune', 'Maharashtra'],
  ['412', 'Pune', 'Maharashtra'],
  ['415', 'Satara', 'Maharashtra'],
  ['421', 'Thane / Kalyan', 'Maharashtra'],
  ['422', 'Nashik', 'Maharashtra'],
  ['440', 'Nagpur', 'Maharashtra'],
  ['452', 'Indore', 'Madhya Pradesh'],
  ['453', 'Indore', 'Madhya Pradesh'],
  ['462', 'Bhopal', 'Madhya Pradesh'],
  ['474', 'Gwalior', 'Madhya Pradesh'],
  ['482', 'Jabalpur', 'Madhya Pradesh'],
  ['490', 'Durg / Bhilai', 'Chhattisgarh'],
  ['492', 'Raipur', 'Chhattisgarh'],
  ['495', 'Bilaspur', 'Chhattisgarh'],
  ['500', 'Hyderabad', 'Telangana'],
  ['501', 'Hyderabad', 'Telangana'],
  ['502', 'Sangareddy', 'Telangana'],
  ['503', 'Nizamabad', 'Telangana'],
  ['505', 'Karimnagar', 'Telangana'],
  ['506', 'Warangal', 'Telangana'],
  ['517', 'Chittoor', 'Andhra Pradesh'],
  ['518', 'Kurnool', 'Andhra Pradesh'],
  ['520', 'Vijayawada', 'Andhra Pradesh'],
  ['521', 'Krishna', 'Andhra Pradesh'],
  ['522', 'Guntur', 'Andhra Pradesh'],
  ['524', 'Nellore', 'Andhra Pradesh'],
  ['530', 'Visakhapatnam', 'Andhra Pradesh'],
  ['531', 'Visakhapatnam', 'Andhra Pradesh'],
  ['533', 'Rajahmundry', 'Andhra Pradesh'],
  ['535', 'Vizianagaram', 'Andhra Pradesh'],
  ['560', 'Bengaluru', 'Karnataka'],
  ['562', 'Bengaluru', 'Karnataka'],
  ['570', 'Mysuru', 'Karnataka'],
  ['574', 'Mangaluru', 'Karnataka'],
  ['575', 'Mangaluru', 'Karnataka'],
  ['576', 'Udupi', 'Karnataka'],
  ['580', 'Hubli-Dharwad', 'Karnataka'],
  ['600', 'Chennai', 'Tamil Nadu'],
  ['603', 'Chennai', 'Tamil Nadu'],
  ['620', 'Tiruchirappalli', 'Tamil Nadu'],
  ['625', 'Madurai', 'Tamil Nadu'],
  ['631', 'Vellore', 'Tamil Nadu'],
  ['641', 'Coimbatore', 'Tamil Nadu'],
  ['682', 'Kochi', 'Kerala'],
  ['700', 'Kolkata', 'West Bengal'],
  ['711', 'Howrah', 'West Bengal'],
  ['712', 'Hooghly', 'West Bengal'],
  ['734', 'Siliguri', 'West Bengal'],
  ['743', 'North 24 Parganas', 'West Bengal'],
  ['751', 'Bhubaneswar', 'Odisha'],
  ['752', 'Bhubaneswar', 'Odisha'],
  ['753', 'Cuttack', 'Odisha'],
  ['754', 'Cuttack', 'Odisha'],
  ['781', 'Guwahati', 'Assam'],
  ['800', 'Patna', 'Bihar'],
  ['801', 'Patna', 'Bihar'],
  ['831', 'Jamshedpur', 'Jharkhand'],
  ['834', 'Ranchi', 'Jharkhand'],
];

// Build O(1) prefix lookup once at module load.
const PREFIX_MAP = new Map();
for (const [prefix, city, state] of ENTRIES) {
  PREFIX_MAP.set(prefix, { city, state });
}

function getCityForPincode(pincode) {
  if (!pincode) return { city: 'Other', state: 'Other' };
  const pc = String(pincode).trim();
  if (!/^[1-9][0-9]{5}$/.test(pc)) return { city: 'Other', state: 'Other' };
  const hit = PREFIX_MAP.get(pc.slice(0, 3));
  return hit || { city: 'Other', state: 'Other' };
}

module.exports = { getCityForPincode };
