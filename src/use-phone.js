import { useEffect, useState } from 'react';

// True on phone-width screens (iPhones held upright). Matches the 640px
// phone breakpoint in styles.css so layout and behaviour switch together.
const QUERY = '(max-width: 640px)';
export function usePhone() {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia?.(QUERY);
    if (!media) return undefined;
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return Boolean(phone);
}
