export interface TollanSkillFingerprint {
  name: string;
  rgb: string;
}

/**
 * Tiny 8x8 colour fingerprints extracted from the official Unity skill icons.
 * They let the runner identify cards without OCR or shipping game artwork.
 */
export const TOLLAN_SKILL_FINGERPRINTS: readonly TollanSkillFingerprint[] = [
  {
    name: 'Evolution_ArcaneBolt_1',
    rgb: '7bv/XiNwCggAoo+auq+1LAcv+9D3/9f/dyyKYhW8FQYjSiJWWy93gTqT4nb6YSJ8SDpAMRpGGgVGFwNKGQB4Lw1kQhpJIAIlGAAUEgEAEQUGJAiOMgqLIwhdIAE5KQA+UixZcTCKaBykNAd0FQcIGAIxl1zPgXB6/+f//7v/qlDnFgAUKglASRJ9bkRpeGqV/fP99cz3VCtTIhcULw9F/qz/ZTNxEQYP//z/uaG2Kh0cPC0rDQEQlHim2MboFgNL',
  },
  {
    name: 'Evolution_ArcaneBolt_2',
    rgb: 'Ohs5SxVbYlNTLR8nOAWRXRDEMRQxGwgHc2hs1cTX7dbrv4fEk0fAOw+1mFTNazhYbmRk0cXO5dLp0abn/ZT9yVvtQBK2PR5Mg3x/onuWnknIVATVUxm2ojPYbRjMLQKZ8/Ly/+r/ZSuOVhFvHQNtQg2sWBW6UhG6vLrKhWubEwUrdU2QlyvDnSfjfCTEWzl1GAgeGgcflG2h/+j/unDxciGlTjlgNRUwIAwGKB8/nYGv//T9i2a5PTVWRzZHFAQD',
  },
  {
    name: 'Evolution_Arcaneray_1',
    rgb: 'HQgOFAY8HANXZzTAfDPBdgGg6K/y/Pj/GAUsQwt7VhivVgGZnhm+5577////25XlGQs9Xye1YwCBt0TJ8cv//v/97N35jCC/ezfLkhzJwlTW+NT/+v/7/fH/s1brRAJ44an/7K78/fn/+v/9//f/2ZHyUwCdEQge16r6/v//+fb98+T/sm/GixTEFQFQEwgZ9en98uj+//3/zqHZixavgkPHMBc1IQUY8t771nz4kkbccx+vSwSYIBhFORFCMwtF',
  },
  {
    name: 'Evolution_Arcaneray_2',
    rgb: 'SgORfQS9ZgeyKxJ3WTWXLQaLUBt9mErAgxO3aDlsTCNZdz6cTBOQPSt1vo7gTDOuPwhZT0Fmaj6sbS6OLQxRjWqoNildeD/SLQg4IQJsXAmubUpjjmCfORNyVDqgiBexMAZ/KQBuQCtJxpTLUxt5WDefRCRgfC+fXwCpZz90sWG9i0S1OQlZnGzIQzJefDy7sz7bo2XjbBPDLQVFRA+SOAlqQRZVlELg1ZjrkCbXYQKuPwdaHwl+SwZfjiOtpinl',
  },
  {
    name: 'Evolution_Arcaneray_lighting_1',
    rgb: 'GwoPERFoDCF8PHHDPYShApOisfb6+v7/Ew9EGUVwJVuSCGeTG8bSov3/////me/wFxRiM2SVB3R5Rdrdzvv///z84O7+JKrZPovDH7nmVuXw1v////z79f7+W8vwCVCEruzysv7//f////3++v//luf0AXDGFwQzr+Xw//7++v3+6Pj+db7DGarVCBqDFwYw7P3+7Pf6///9p9bYHKeySo/JJyQ0GRAP4Pv/genxSazzJIrFCmG0IxxtIy4yHCo2',
  },
  {
    name: 'Evolution_Arcaneray_lighting_2',
    rgb: 'CGTBC5q5Dn6xFj+1PGW1Cz+sJ1N1TbLfHJirR2hlK1V0RYawFWW2MjyRl8TONV7pDVd5R2qPPaPeOH6IFC53c5GwMzSARIvnEE1YBkGpDnjFWGJhapKjHjeEO3nPGrfHCj/BAD6cODham8vNJFp2PG65K157N46eA3/GT11TaLy5TZCsDmRwbb3ePzdsQo3FMsfharruF4fXFSY9E2W0EE+VIFNdRqrxleb+J7f/CXmuEUN5BVzWDHqGLKGsK871',
  },
  {
    name: 'Evolution_ChainLighting_1',
    rgb: 'HCNHDSSOH1jAHkeDBgAACQg3FCFHGBU7JluRS119HRwiZK7gi4yQkJyfaH2SMEtsHSI5dbGyDAgOc4yblrPZW3WBvdTUIwwNWK7ZU5mgZaGtXtPTmN/qOUE/isbFVlFRLldedcPPntTVGjg4YWWIs9biRmZpXVR6FQAAEQoPM1tmOY6VLUpbhoWgj56xb5vQGwkMHQgJEAAAMS8vRWxvl6HF4f//p/v/GgcJGwkLFgcIOTs8PUA+WXue9/r9/vv8',
  },
  {
    name: 'Evolution_ChainLighting_2',
    rgb: 'GhAUGSMuGRwgVImQXoWLIl2OEQAYGyIrIxEULWJxhMvQs/T3uvr/otLgI1eNJ3CsKzlCeaqzbdbpNK3FUr3QvP35f9PrO3OYZJScsebpn+Xs6vv78Pv8gdfjiM3iVlNWU3F+wfj5nfbw9P388P/+ecjbr97qfZueHBIfor/Btf/9mPDrg+Djkezwrs7YFiNDO0pPWH6Nl83ey///s/j4isvTZaGxOUFQJS00Ew49FUZpRGVuapWWQ1pyCQAbKjc6',
  },
  {
    name: 'Evolution_ChainLighting_3',
    rgb: 'HF6JFBZIFhwuKxUVTWlnFRtDD0d5Ube3OGWVJD6EFRcrb5WWher0HThKPExgPi8vGg4SPWaALzhBkObmW9jlNIeTP0dDL0A8Qi4uZmRiMo2U2/v7jcHbGXGkNVlUJS9GhXh0EQ1NK3jPaMXXlJfMAB5+Q0uBHCaSDyKTMV9sL0htUr7qPne1Wo2qfJOqkoyYOUx4KlhcUEdvYqSrIIWqQWNnGy1dgrTOz8qyDhZoW1iOPzpXDBpuFxxci5uLQ16y',
  },
  {
    name: 'Evolution_Inferno_1',
    rgb: 'GgcJGgcJGQcJIw4JLBUKGwkJGgcJGgcJGwgJFQMJLyAKn2AKr24LKA0JFQUJGwcJGQcJIQcKYSsKbCQGajALbUcMGgQJGgcJGggJKAIJmjwIdEIJbB4HVyEJGgQJGQgJHggJIAMKciEFzFQHvVYKShQJKQMKIgcJJQQKGgQKLgAG6YAKzXIKKQAIHgMJHgYJLA4KSCEJRhIJ2pUNtHgLTygJWzkKGwMKIg0JMBcKLQ4JNygLMh4KLxMJMh8LHAcJ',
  },
  {
    name: 'Evolution_Inferno_2',
    rgb: 'CQAJUB4IxWsIuTYEkB4Gqz0GwFcHZy8KZDYKvz0ElgcDewEIggAGigAExigByVAFj0kJ/6MGviYBng8DmxkFxjcC/Y8DjS8HaxEG/L4O/9oU/8QS/+YW/+AU+pIGlEIJrlkK/tIP/OIU/t8T/coQ+9MP/8INwGUIrlII/7UJ/tYS/+UZ/+EX/uUV/JoFlCYEuDgE/JED/LsP/+cZ/+MY/eAX/9ETxYoOlxEGtSQB0EkC/8gR/eMY/sIQ8tYUizMI',
  },
  {
    name: 'Evolution_WaterSpirits_1',
    rgb: 'JWqxN2CCGg5AMEN+W2mYERpHPL36Okx5Ezp6OIvAVo/AUcnvjaa8ECNsVGBvU2F1FkudEWfAGJfXF0BeDxlUIW3EPluPHB1CFDaRIzNPGiBAGQ8nGh0sGy5OHSFXGi1jFCl9e8LyUmyMDQ8cGgAADgASUIq4KXGlf9HkS6ryG4bEFShbHS1RapHAjuT9IBotIm20Hav/E1CSEAUfVGmQoOH2HTldERBHFhFRFEufF1GzHH65Fz9kCQ49ITNsMozd',
  },
  {
    name: 'Evolution_WaterSpirits_2',
    rgb: 'GQIAGAsSGA8aFBUvFRw4EClTFwsTGwMAIhoyBjSOAD2rADqnDGbPCWjPBVK3Ehs8J6zjGqDeGILYGYr2BnDvEHPiEWrDAzOIJsnyf/H4SN35K7v5J6b5C3nyCzNtAxdDLtDpYN70adbqQsnvPKz7BjSCHggIMiEkAKzZONLvzP3+Tcf2ADegGwAAFkl8VdHzFKXwH7PtOuj4IHmuDhY8FBo2A1KzClB/FarvJ7vyH7DzECdbHGSGHy04FQQMHAAA',
  },
  {
    name: 'Evolution_Waterpool_1',
    rgb: 'CSRERF1ur9bcss7S5/P0y9XUWH+bDDNINnOQf7DR3f//rPf/9P//xv//mdTyW3KTO0BdJJXdIrz/A33hYMv6GYrfcKm5KD9EHQkLGRYhCFm+CGXfBJL6FyhTFAcQFxopGQUGGgQDGRUsGnbSLX/dGQMQHAkMGg0lHFFuHCoxFx83GWW/KZzzFixbGwAEGgQGGC15Fy5JGDBqE2/fEU/FGD+RFlOrFzqKGRI/FkKXFVO7F0K2GTCmFWDME4HnF0GR',
  },
  {
    name: 'Evolution_Waterpool_2',
    rgb: 'HAgLFB9UEiJxCC50BixuHhwoNLHcBm7VBCd5CWrbEiVZGwMEFwQPIAkOP2BzBzR4P7LtKpzyDxM2GyNfHlekJVWqNFaKGgsdYPD7SajPDhRGEWDJIoTWRaDnT5boIT97O9v/FlB2FwceKWy+JHjLFXrTEWPSDjFrGz9dFgIMFggUHhIpKVGMGDN2GDGGNjJNDBhDDi9kFUV6FSVSIFORHgUKEStXR8r+ERY1BE+uCW7WC2rXE53+Gx4jCzh6CFCJ',
  },
  {
    name: 'Evolution_Waterpool_3_Waterworld',
    rgb: 'Ka3sGVyvHm+1L4u7IVOCJnOnJqHiGJbpIG2uOaPJLGaYGHvQGoXQJ3W7PpnAMJjOIIHOKFiFMIvMG73pGsbpLLf7Jn23NG6NLoS/GFOlFb37cOT+tvH/R9j6DqvsDWmuF2GtJYK7CbTrVNb4h+j+OM31Dq7kCX7lEl+ZLG2RKZ/kH7X4ELzqHLbwL6XkLoHBDGC5LHGURZerKG+xCWPNEmXFNYa+Qb3nIrbsKp3lE1iOIFeAEU6mEkGJFWq6KKrs',
  },
  {
    name: 'Evolution_Windgale_1',
    rgb: 'IREYKx8nMSgtSkNGiI6WMyouNCwrQ0JJT1FTUVNUKh8eNzg+UFJaeXuFeX6IXGNlODE0JxoaOE1djrbMf6XHRlZkj42ca295KRcXX3GLiZ7XT2tphqW+g6C9iJegj6KkXmRgjJ+zn6baTWt2dJGnc5GpYGt0XF9kP09ak6Gprb3NfYidb4CROTE2XVFcKh4jPz9KXWlxlp+pgHuEbWhwUVBROzc4PDY6LiIvIhIULCQqOCsydICHbn6AQDw/JRca',
  },
  {
    name: 'Evolution_Windgale_2',
    rgb: 'OkU8Q0hKeXVrZ25xWnlnQE04SmNSPkhQQlp8a5aLaItkjJStX11tQ1Rxj5aGX39oN0tFboRWe39yFQACNCIkUGFVYmNmTVxzN0VPbmlzbV1XDwEBIQwRNS0jR0BPT1BXZ1g9YmRUOyYkFgMKIhgXVUxVeYtxhn1VNz1BXns5d45hQEI5ma95eHJuf6VHbH1IIys+S1Rha29de3xdfIeTbYSLSGlQNERQMjNBOkFNLzAyODEaNEBTUnSOQEVIaGdY',
  },
  {
    name: 'Evolution_Windgale_fire_1',
    rgb: 'jwAUjAgLqCgeYzAThwEWpQMXjjsQnzIQ8WESpnQupEEmukUNRwARqBwLxhMOtkgTfjIJh19F5Fga0VEu1UIhwWYJ23UkvwAIWjMR55sH1nBnljU5zHY7w0wt2l0zvA0UskQD48pC/duQvm9X47RZ6og6/5tUhUoU0QYNxJZV5JkatTofsUMRvGsjeVMVTiYFpQoV82pRyjsWswkMiAUUUBYIkhcJqVMMlxgYbQoUqEANtEMRzCMg0SggziEajigO',
  },
  {
    name: 'Evolution_Windgale_fire_2',
    rgb: 'VR4dVDQ3roBKoUU1hjc0YCgdbBMQZRoWigAStyMfl046soB/d1JPgxUn1XNGmiofXAoSlkwumHhdGAsFRS4dgDEogVROhxwwXBAflVtQhnBKDQAAKBIPOCsjVDM6eDQvfmI6hlE8UzwfFQYILxMKbVJBqltGwYQ9YhYXgzsdomw/UDEptYpliXdjrmUtkVEtTgQQeCIrhFxKm3RPrWVel1FSaR0jZAATUR0dbA0ZShIYRikXdQAKpRAkbhsbnE0w',
  },
  {
    name: 'Mutation_icon_Annihilation',
    rgb: 'JQ8RXjk3MBcabVNWgmViXjs7PCAiOh8iRCYmOR8gqpSU1b25z7aytJOQNhwcLhcZFgQFUzU4oXx5nnRvh2FeroqFZURELRUZHAgJVzg3RBYUeCAYh2poWwoDWi4wUDM0QyUlZEJAnX15kmxpaExKaDMuWjUyIAwQEQACJxEThVxaimtoXUZHe1tbQigoLhUWYDw5KBIUXjg6aU1MUj5AUTU5HgoLTzAvYz88PSAgNBsgZURFakhIOyAjSCooPSAh',
  },
  {
    name: 'Mutation_icon_ArcaneHeart',
    rgb: 'LAsxNgxLKgwzLRI+YxR4FwgNNQtwPAxmSgVOWhFSGwYzPC91PSpqVQl1VBJhbB9kLBg9gCecwDTASQ1hURpX1zfbVixmQzlkNRxUTxZa9lH+uG28yYXO+FvyUhRONxVdOAtXOAxUoR+0y53NxZG7vErMShpnFQQsNAlNUiRuWjh4pjiv5zXeQyOAlibPbRdxIwcPKBMyMjRjXRaPOgpWBAUrOBNMVBBjGQcEFAQiGgUXMQxHFAcCHwcNRQ1DIwkT',
  },
  {
    name: 'Mutation_icon_Charred',
    rgb: 'EwoLOkJFY25yTVhbR1FVUV9jHxUYNQQEGAwOKjM2Ky4yMzk7KzAzMjM5Ry8mazAZKAoKOSEgKjI3KS8xGRodTy8mNSAaq2cuSCcURz9BTlJRMTMzNzU3m2pCaTsfVxkLhT8hhWpOckYnAAAHCQoNNxUSy3g33Hk05WopyXA3c0MtJCwmAA4agjEV/6lI3XM18pNG/8de6K1QonM/URwa3nAr/qtG33425pJI+rZY/9ly/7xW8nIm/bBO/c5j9ZRB',
  },
  {
    name: 'Mutation_icon_FireStorm',
    rgb: 'RRcnQCokKAkCNwAHh04XPR0ARQAMRCAygxkWrWMeWiwdaxQkZBQceUlEiTgSiiwaOgsPyDYWnltgQEBIEgYKj36Gpl8riBkVVBgThA8WFAAAGQYHFwMDGwAAoSEXRB0fWj04kmksfkZKFgIFGxkem2By00MikU0xMBoU7K4syb15SR0Tehge2I96vaI/oV44fwcUy2Ie8bQn8o4z7Esg/4UxiDMjEhIqOAsVVx03oiEaZAITYBoXn3UcPhURGQsP',
  },
  {
    name: 'Mutation_icon_FoggyMind',
    rgb: 'JxYZaGFpcm17eXiIgYKRbGh0a2RsJhYZST5GbWhzgIKVX2B3c3SKr7LGsrTEU0pTZF9peXuNnp+zkJGmioudjo+jkZGirbDAS0FLYGFzy8/hurzNlZmmpKe5YWZ/dHKBLyUshW1yk4KQk4yfs6CvyMTSh3WBTEFJHQ0Omm1xt3iCxJ+gyZKUq4GSbElPb216JxYZMCEnjU9gy4eQv3+Iq2d6PyIqHxQbHAgKEAECcFBMm2dtjUhhuneHYDA9DwAB',
  },
  {
    name: 'Mutation_icon_Gone_Fishing',
    rgb: 'GgMAGRo6FkOUFzGSGwUiGgofGCZoGgUCGRcyFGvaFX/xF2fBFFGVFGXDF1jRGB1dGSZgFI3tFZDCYqs/aKc8KaO1GKr1GjyCFWjONbKzh7I6pNZSnsoaX7JkEbX/F2rECxtka5Z9wdhbnsw+ndA5RMnAFL3/F4zuGQxAGGSdKJyjMXd0Ko/DFLj/Gbj9GGi4GRQyFzluGGOWGr79HLvsHZrYFZP7Fj+NGgYGGhAeGgAHHBkjHR4cFx5gFjuGGgsW',
  },
  {
    name: 'Mutation_icon_InfiniteRecursion',
    rgb: 'T0hJSUFMCg47GzlTQmhxOFthSjc4Ym5uVUtOUl9aX2BoUGh7Z4F+PUFEP0BFHwsNBQAAOEZJ////3+LeVlhbHTA8XF1jND1CeI+PK0BLhJGYvMbHSkRHCggJr6yttLS3////ZGZrJh0eCwACbGtuU11ddnt8T0BAcnqCOUpSe2pqh4uNXmNnKhMWFAIEL0ZJRUVJCwAAQVJb5unqaGdpJiwuHAkKHCIqQjs9KTc7GicxR0xORkZHKjk4J0dRGREV',
  },
  {
    name: 'Mutation_icon_IronVeins',
    rgb: 'KSQnLCYpEQAALSgrLy0vFQUGLSgrJx0gMC0xcJOXVWhrbYuPdpueR1FUaIWKMjI1GhIUb4+TgqqvdpibgKmtfaOnbY2QGQwOPkRJbpCVjb/DhLC1c5SYfqWob5CVPkNIJBweTl5jkcbKkcbLh7a7g6+zSVVZJR8hIRcaPkRJeJ2ijLy/gKqubYySPkRIIRcaKiEkWG1yRlBVhrS5d5ygQkpOWW90KSAjGAQGHg8SGg0PPD9EOjxAGgsNHg8SHBQW',
  },
  {
    name: 'Mutation_icon_LightingCharged',
    rgb: 'GwYEFQQJGAAAFwonGAgiJQoCGAQJHAgJFAwrMBwhWVpQST0sNltYb4pzOyISDAAPUkM3V1+FL3S9Y6u0YKzMXJ3PYp+kTzMkTUpSP2S9RYi9Voa1MnvIZrfLFW/cdZeYDhJSSnvHPKXQJkucW3mRPWahKVaoEnHRIiA9NFJyRYrHNVurU4S3JjmTRHK5JDtwGg8fDiJZMEJjZISVEAoxGSxtWF5uIShMGgYHHAUDFhEhIUaIGwkWHQoQIQcAFwkY',
  },
  {
    name: 'Mutation_icon_LightingHeart',
    rgb: 'LBkbIA0OGAAEGiFUFipcIwkJQEioCA1uOE1ZV01NEhJIJi+AISRpOlirZYOkb2FrGTZoRoO2S9HhDT9yKlZwgOb5S1pqNTxgHBBRGFdncv7/g9/tluf0r/v4P1VfDw9gDQdZNUeBUrHK3ezw9v//hLXQW2iPX1VmBwlPdo62ZWWJNp24cu/4NVOoPXzVUl99IhUWN2x9KTNvEDubETh2EQRUGDRdGS5gREpKLlBqFQUYFApKHAAAGgwNHjZKGxMT',
  },
  {
    name: 'Mutation_icon_LightingRay',
    rgb: 'GA0iESF+EDqmIDdpP1h1HUiOA0+LQqyvFBVOGzZdFA1GCBtoK0t9FkRaXbS0KxscDwxnEhVPGSMlTH59R3l4VX17hn6TE0R7GCE6N1CEK0FYUXl9Y2Bkc56iGCQnG2KHGlxwKVhkFJadG0pQDQAAEBUYFS1kFiJokre/levwVaGhRyktJTEtHJ/OEyyFGBEpr/f/rNvlkIKMUImOGrTRTXO0LDI2GA0MtvX8g+z5DJzzBl3IDCyLEQlOGgMDGgUJ',
  },
  {
    name: 'Mutation_icon_Tempo',
    rgb: 'GgcIHREWLhMjNQoYMRQRKBQMvJdNbFIwGwgKHAwUWjsnSiYxVBsnUiIkd04hOR8TNRAqNB0bhFQuYjQrKg4sQyMgWT4fQBYTJwocQyYYlEs2jUAxbDgsSSQkWBQaLRIXGQgGEggOaTEdfTYtnE0se0ItMxcbHRIdFgYKJg0To2s3i0wtQxsiJRsePRgnQCA2GAYIf1Qv9qxMjkktJBMbLx0gKREZPTBFPSEXpGM2dDUpJg0PFgcKHAoMGAYHGAUG',
  },
  {
    name: 'Mutation_icon_WaterHeart',
    rgb: 'GQYOGRUkGRMmGgQCGgsaGgQGGgkSGQ0hGg4nGRYvGChEGgUKGRg6GSA/GBApGgYHGggaGDJcFIf0FWOmGCdeF2/dGSdHGQgVGgIAGxxZFpH/b/T/JmzLE0PGGjFkGgAAGQsbFU2OHFOxKqb5HHbsGDqKF0BsGClAFyVSGBwxGQ8cGy6oGkfKFyNHGRk3Fy9aGRcrGSJMFhhPFxo6GBUtFiNdGCFKGRI5FzZvGCpTFyNpGQ8rGQYPGChYFiZVFjFu',
  },
  {
    name: 'Mutation_icon_WindHeart',
    rgb: 'LyYzKhssIBUJFwgEQC85dG9/XFdmJhggIREYHQ8LUGg3eopxk6CTl5GhamJrMSczJhUlP0JNdZSJb3V3VmRcd4yRkoyWIhUgIhsVVWhcw+74haOldJ5qwN7korSiPDQ1LS4Vl6eYyO30z/z/ptGuyNTDaXBhLCAnOy86q6TBU1xdsdvjs8y6o85qPzo4IREgHhAabXZrV0xUU2pHe6JbQUMjLiQzHw4RIxEeJSYMODsmOjI7S0BLLyM8IxQbJhgh',
  },
  {
    name: 'Mutation_icon_Wind_Seeker',
    rgb: 'GQwJBFcZAoIjPYosQUQ4SF0tJSMPGAMIFSAOR6dYFYUsEm0hbWZsSk49U15EMSEmFwEFW3pRVWdKdj1XLCIcTEQ9QEIvLzIZGgYJTXlKWm9Qe3pednlpiYWSPDIvKi0RGAUHSmY+fch5YdBvNZ1bU0lTUEdMQ0E0GQAEEBgQKKVVKGc3Iz0sOD87VlFMfZheIRwLKHszGFMrKhUMHwUJHCocT2lFjJV/HhcOKC8VHAUIGAQJGQYIGwkKWGpaO2Ay',
  },
  {
    name: 'Mutation_icon_YunoBall',
    rgb: 'HAgJFgYIDwIJHgAKLwARYRgPYh4AiAgJEgUJMAkMZBkPlUsa2ooI+9Ve7sZRmoSELgoKuD8N3GsU/rkp//FS9v6Qb9L2BlXGl0YJ7GkG4qEs1sqC2/T7u///Qo/MFAATiiYP4U4E1n822P/6rub4ecnwMFJ4FwkJSh0L9nMHt7uateT6ZsP+F1G2GSZbGgYJGgAHs2shUrvobrj/UrXyEjx2HQUDGggLHAYEKxAoN2iuV5O/IU9vGQMAGggLGgcJ',
  },
  {
    name: 'mutation_icon_crazed',
    rgb: 'ZQ1tKwQpgURl0ICl1Jmam0x8QgY8MAglZhFuUQJap1iIu3aP4aWkyYSaPws0JwoaNRIrZDRLczFlhV1ez5OZqGeCYjJITA5IRygukFdpqWeLwqa8t2iKxoufpWidIwAVOQ8sgERmsFyXs32SkICEoomOjkpxMgUnFAgAMAAwi0pwhFRZAAMLGBsiaydYQQlAJQcVQQs8dxV6gExiRCklVkNCTCJBKgAtMwYoIgwSTANOah90soOTnWmKPgpGTgRQ',
  },
  {
    name: 'mutation_icon_eyes_of_fire',
    rgb: 'MQcLPAIJLAIJKgEISgAPPwAKNgUKKwMIKwgMQgMLWAkNZxMNnSERfhQTWgIOKwQHKgQIWw0RzGoV6p5F9bhhxHUOZRwQKwIHQgAOiS8N/Nw9gFJKjExd/8JipSoPVwAPJAIJgwgI/8JFnoBne0w4+65ZhhUITgQTTwQMTAEQghUL1Hg12HIzmRUOTQAQNwYJIwQIRgMLXQAQQQAISAAGHgIKRQUMRwMLPAQKQAIJKgYKRggPSwcOMQYKLgUKIAYJ',
  },
  {
    name: 'mutation_icon_fire_heart',
    rgb: 'MAQKLAcNNwMMMwEKZQAVKgUKLwUJKwQINQYKOQcLkC0UcRcQzkUabwwUPwAMLgQKUgMRnxcXjzkavmsi8cQts1McqE4YZDsSqzoc5aIwzEgqx4ww88s50WIv4cE0YT8VVyYQymcu2hYm2Dck63ko8oc0nzMiJQ4JEQAHUQYVyTgn6lMf51ckyz4qUwkVFQYHGwgJEwoHZS8W00Im0DEnXQcZEwcHGwcJGwcJGgYJFAcHeTMbdSAcFAMIGggJGwcJ',
  },
  {
    name: 'mutation_icon_glass_cannon',
    rgb: 'EwUIKgEJOwkOFQYIGwYIWFpaQUNCGgoKHxEMiDgZKwAADAAAbW5wZICBY4WFTllXKRINhH9xPURGcXV3nK2xKjc6PVBTWnNyEAACf46U8v//m8HBncTGboSFWXh2PD0+KBkbiKWjlq2oO0tGS25slsPGaG9wEQABLSgqa4mJQ1VPHywqN01MiKaoHwcJFwUHGgYIOEREMkVDKTk3WXBxSEJFEwECHAkLGAUGHQwOMzc6RVlbQURGEwAAGwgKGgcJ',
  },
  {
    name: 'mutation_icon_juggernaut',
    rgb: 'OEFDJiAjIhkbMDM2LzI1JCAhJiEkNz9Bgq6yXXd8PkdMTWFkTWBjPkdMXXd8gq6zWXB1UmdskcbJZH+EY36EkcbJUmdsWXB1MDI2U2drjLy/b5GUb5GUjLy/U2ZrLzI2FgEDPkNGZ4SKW3d8W3d8Z4SKPkNGFgIEGgsMIhwfZoWKaoqOaoqOZoWKIhweGgkLGwsNGg0PR1VZcpWacpWaRlRZGw8RHA0PHRQVGgkLIhwfOkVJOkVJIhwfGxARHA8R',
  },
  {
    name: 'mutation_icon_lightning_shock',
    rgb: 'FQo1FxY/LmCREwY5GBEqFQAAGwUBGwYBEgc+GS12OTpbBhZmMGSbPl6CDw9KFwwtGQMPEylEBUyaDkaREAdQIVWeDiVdFAVGGwMCGgULGhEnCgApKjiMTIapJx8xFRkjFjEuFwcvCAhTUU5Ub5jZFTBjJCApGTg8EVFYHxQeDgZDQmixVnmGQzZXEwMtSFBrEhwhKU1QVUU/XGJtisvSgLexBhdnS1B2HAcIFgAAJUtSR6Squr2+wubtImSJEA8O',
  },
  {
    name: 'mutation_icon_muscle_overload',
    rgb: 'cx8e/lE9vTcupykquS4vghgokiEodBkhPg8S4kQ27Uw5pisptSwtlSIpjyInjSEnCgIFgCQh/1Q+zkAznCkqih8mkB8mjh0lGQcJGAYJ0D0u7GdWfTYxWgkXmTU0jzo5FQUIORIR0Dww4mFTYygkQAkRkScwezg2CgIFiScj/Ew78lRBWCEbZhcbmiEpXhIYDQQGfB8g90o8ujcsMQwNjyEnlSIpURQXDgQGXhkZ+Ek8gykhFwQKhhwnjB8mNAsR',
  },
  {
    name: 'mutation_icon_spellflinging',
    rgb: 'FAIDNCgmnJim2dzhrrC7eT46MgQEFgUKKiIYpK2vjIaWiZZ4q5CRbkMTq3EXNgwEPUslREw8AAAAWC4qkFlRAAAAj4JNupFjQQ5FalNxUidAhlFLXDU3AAAAwbmh3tnPOQ1j0ob/kTqkbkQ6ik9PZTo1VU5gNkl0fjmX3n/+jUmqs25jiFRbZ1F1IFmsAD6dRh1pmyDhlU7QoGZnea3IM8nxE3TGFxY1CwETLwZVdjl4Tic2OoSpKbXeLTthGA4j',
  },
  {
    name: 'mutation_icon_wanderer',
    rgb: 'EAEFVSshgEk3YCsdPxkXNSElLB0fMCQkDgABVDU0sIR3MiYtQjE4RTNCNikrWFBPGwgKGgYJTEFRWGx/inR+aEdLZkZHPy0uEwIHHAgGTjguWFlmTUVJf2lsZ1BTW05PRSggiF5Bi2E+cUk1Ri4lPDY2S0NCOSssQSQdbkw6aEQ9PycoRT05Tz89U0xLY1tbEwIGGwgKOh0hXjlCOC4wOCgnbk5QVElIGwgKGQYJEwMFHAgLHwkMIQ4RSyYuVjI0',
  },
  {
    name: 'skill_icon_ArcaneBolt',
    rgb: 'GAcHJwoeJQoXGwQmCQAgBwAiLQo4OQ1sFAUGRBtRUyFbRSRMeFWDah+GXhuuVhZ9EAAXLBhOzbHUz6PN/IP//ZH/XDl+Mwc5KxYdyafX/93//9j/8tP7jFqcSCd6IghRZ0lk45n/+tf79r74//T/u324RBhqLAtEd1d/58P+//j76qv135HzqoStOyNBDgJHVEpI8O706bz//bv/lV6lMRkmIgsUGAYTEAAATThGaEpqemRvRi44EgMBGgcJGgcH',
  },
  {
    name: 'skill_icon_ArcaneRay',
    rgb: 'HAcaHwdYLgmFMg9TVTFtLQ8+SwBP3HL3HAc4OA1hGgYzQhCjbiuzgAOx2H/uz3vYEQU8EQEjUhaJXQyIfQeKklSRppmueBO+IwY3VzCRaQifmiOpuai5lJmJag+ROAVVbCKxu1PoxVDd7dX1s7S0Sg9MQQKMDAgitoTO89/9opqYpKKqXzJieg6/GglCFAUJ4JT43ab8uqnGgUWOiw/Db0eoOxpAKwcx6bjz24nzawTARAGZJwVnDQMmKgorKgou',
  },
  {
    name: 'skill_icon_Brutality',
    rgb: 'HAcJHQ8bTBYLQRoUmkkkey4H6ppPw4hcHwsSIA4TSyUfdiUboTwMvamjqoJZXioSJxYhPx0oiCYYYgMAr6KiysrUg0MkhTUZVhIbdhQNWAAAi3uBx8rPnjgTqEUYLRIRlFU1cCgNY0tanaW1VRYWsDUKcDcmIgsPzJ4zYUdBYmqLThIUdQsAdhkVRRQZKBEZbzgSr186clQxjVQpYgoEaB0cLAwNFgYJcjYbd0UVsYcrNycZQREZMRIXGwYIGgcK',
  },
  {
    name: 'skill_icon_ChainLighting',
    rgb: 'EDOoLmR1L11jN4OPKE9dP4iSLFZgEg0VFAk+FQgvEQIRHC9OFCMtJD9DOGlxQ6y/GwYAFgQNOTRnIxI1XktImpibr8jKVZucEgQJQTs7sMbCmMbAnsXGm9jbOVFYDgAAydDSlunsSXd4RkFCJx0fCwAAFwABGwkLot3j1Pb3x9jad4qOPjs/hX6AOi0wGAcJOFFVw///9P//rOHmkdrdVYuSOzU4GQICoqGkNlthoN3k////////vPL0P42TFCEl',
  },
  {
    name: 'skill_icon_Collector',
    rgb: 'kEEyejUrXVhbKiYsJBMgJxgjJBYeHQ0QcjUtW2pwj8PGcJCTRktTMSc5MCc6JxcjPB4hbZOXc5yhgquweqqrSUpXNiMzIREYHQwRckhWe2RwSVhceGx1iUxdaCtBQSItIRUkrnN+qGZvDgAFZSY3t259XS87HgwVHhIbVDdLn2d0N12fazJUk1JlNBknGw0SHAsOHAoPKBkmHWmuUjpRgEMzKBMSFAAAGQYHIQ4UIhMcIBonLA4NrUwQXCocUFh+',
  },
  {
    name: 'skill_icon_FireBreath',
    rgb: 'IgYIHggJJAAGVyoVt5g2/M47/fPr6urVSAYQYgATokki/rcw/80s++N8//+5lYRPywgosCcc6JMu/b4s+9E2/dw5/905azISyUMi8p4c5I0n+rwo+sMt/sUp4KAkNhEM5Gcu9tAz/90v+9Iv/dUt5ZIkiigYVw8T6mIr/94u/OM4/uY3/OQ2+uQ4tEwdKwgI6mMz9pAf/s8p+8Eo/uU0/80o1nAikikY6lkh7F8f8H0v5jsm54If0mkh2lQn3EUj',
  },
  {
    name: 'skill_icon_Firetrail',
    rgb: 'GQYIGQcJGwYIGgcJGwYIFwcIFQYIGgcJNwYMMQQJJgQIKQgKOQYLQAYMTAcOHgYIKQcLRgYNWwMOVQAQbwITVQIOQAwPXgAQQwMLYgARfwASoRIYsi0ajh0TRwALvQ0eKgEJcTITujEd3G8fxoYhsgMbvxsZ4n8hLAIKgT8bWzQNvXs+wHE77H0l3J1HjGQXHQcJIgAKEwAIIQQMajwXqFsbXiAdgSEVGgcJGAkJHAkJFwkIGAAFZg4RTh8MMRYM',
  },
  {
    name: 'skill_icon_IceBreath',
    rgb: 'QmKHLzRSHyA5TUA+b4eVUF1+cZOuP0xvJSg7U2V9V3yWPEZaTWyUVWFuXoegNk5qFgIBbHF5YHaNeZCmXnCGirbKO0xfKygxJiA0JSdBLjlONTVNscbRgKzMJyMzODpPJBERaImZP2yfamd4iJaaFQ8oaJjGT2+ROTAyQk5VPGKGVFx4SXipQGSPi5afRlFlHxERgaSzarTnJic3gqG2LTBBRjU4U1hifHl5ho+SCwUMPzY6QS4sQUxeHxYeEgAA',
  },
  {
    name: 'skill_icon_IceBreath_Evo1',
    rgb: 'O1l8LTJQICA6T0NCbIOXY4K5d5O2PUxtP05pW3CHWH2YMzxPZpS8dJW6jqvPNEpnRUlZd4CHWGyAhKHFnNf/VorCd6DMLyk2IRcqHxwzSlZ3nr7utsv2fqbdOklmNTZKIQ4NbY2afcPzZp7GlrbdJCA8Y5K+UG+SQUFKeb/yTGByrbvMmN3/Nl6JjZmhRlFlLB8jZKjffJjFrsHhhbTNKyo5Rzc5U1hic3Z2ZHuGGx0sPT5MPywqQUxeHxYeEgAA',
  },
  {
    name: 'skill_icon_IceBreath_Evo2',
    rgb: 'GgcJHAoOIRMUJRorSGOOOkNdGAIGGQYHFgAAIhsubKLRgajKZY61q93yPlV0GQIAFwkUYYWomu7/YaLDOT1Fk/L/sOf/MCg/LS1Gitb8erzZc6K7PkBMR2uZerfePU9wIgwHlrPDbbbgoK+wKxwierzqjcbjLzE1JBIZcanfgeP/X3uWPEZSnNblk+f/JyEtPElyYKH2csv6fsPsbrLYeai9asr/PEl7VofCWX/FXorUUXu1YrLrWp3aYpbpSmGc',
  },
  {
    name: 'skill_icon_Inferno',
    rgb: 'HAcJDwUJJQUIUgoHeQwGWwcGKgMIHAcJFAYJShIHkAgDigAFfAAFqCYGghgEKAIIFAgJQg0HsUgJtG0Qz5ET56cQZBwGFwMJHgkJCAAJdygH/+gV9LcN9qANYxwHHAMIGgcJHQkKSAEGzFgF9a4Mr0QIMwQHGAkJFAYJMAEJRAQHwEAD8cEUaRoKHgAJHwgJKxEHjiMBgh4DrEsIxlAFehgHZSAFOwgKXxcDYxsDfhYAl0gEjCYBawUFYBEFQQMH',
  },
  {
    name: 'skill_icon_Lifesteal',
    rgb: 'Ph4lNBogOgMMIAAAKAADKgQMMRccPh4lZlpokXaEqmx5qnN7m4GJiDNCglNlZFJhgnuA3t/iYVpkmJqfp6mrXDtFrKGodm1zaC0449bZZkpMFgAAMQADRxsdzsrMRCYrMwUNbUBGd0hSRxMgYiAwkzBAmlhfNAkPGAoLVg8ar3F+lExbZ0henoKRcxonLgcMNw0VVgsSeDxLrH2JsX+Jh1VkQgwWUhEaGQYIJAoPQQkTpRYkkCIxOwoRQw0TJwkM',
  },
  {
    name: 'skill_icon_Ranger',
    rgb: 'GQwNDx8hEDQ+FysrQBkvMRAjJxckFhYXGgQFFh8lFjtFGC4vKBgtGRUUKxoZQxYaGQUFFyMiGkhTKF1xTiovgSYudCItbR8rETVLFkljJFxtJXOKMjc4XR4jUSIlPCAjFCErFBwoHzIyJWV7JVNYWSkxayMqVCAmGgIBGwAAITk/J15nJWyCHTEzWiAmOSEjMVthOY6jL5nSLXeIHTgtGCEnGiI1GB0bIkJTK4KpJ3KaHzM6Fw8OFBkgGhcbHhES',
  },
  {
    name: 'skill_icon_Rejuvenation',
    rgb: 'Gi0bFBYSL0ghQWopMl0oJzIZHg0LEwsNHx4SJTYaKlwnUX4rRWsmQnMrLkUfPE0eIhcORE4kfCMrU2UwRVcpeywtLT0jN0AbDhEQX0Mp4GktnywpnTMp4VAoYS0cCgcMExAPRCkm10Yn5UEi5UAiy0woRCcmFA8OQ08eHT8eWxke5jwl5jslXRceHEAfRFAeTHkuSGEjFTQceDAleCkhFS8ZSGIkTHkuTHAqVIYwUYYxPXgvPXgwUYYyVIYwTHAq',
  },
  {
    name: 'skill_icon_Scholar',
    rgb: 'XScPUDsldFAqel02i25Bn3FSmW5InoVOpZJRo3JGp2lbxn1jwXVku2tiilZJhVwvgGc2oW9Gk0xRik5NfUZGgExDgFNHYjMbUBkLaEcocU1Gj0lEqF1Dz4ZUvHxfjWlFTBwLYCAFckswtG9b559o8axt/Kppu4dYVyMNFQICXD4m3Zpm/810/8x43WtSk1hKHAkIUBwKbEsyqGFZ0YlkuHlij2BTYEguRRAGbjMQimZCfVhNf19Fg2M9dFEnRh0N',
  },
  {
    name: 'skill_icon_Transcendance',
    rgb: 'MhUrTCROcDZ4djV6ZS5tTSNMLhMkKxEhIw0YPR1DczZ1sl6UoliIdDZ0SyJMQB5BVSNJlUKNqWJ/xIJAw4JBt2aHjj2DVihYjDyJrVSWuYFP68Ji2q5XuYNPrlSXkTyIbTFzh0Z1tIlR9Nl3zqhasohPq1aWZixmRyFJZzFfvXF638Jrza9fsGltfzt1LRInOxo0LhIqeDtxol9tsWl9mEiLUSRTJw8bIAsSIwwUIAoWNBIkXSladTZ9TyVOHgoQ',
  },
  {
    name: 'skill_icon_Traveler',
    rgb: 'JRgjJCQ1IB4uT1FsWlx1IRYkIxQeKR0vMys9IxgdHw0PNDFBSkpaMio6LCA2JBYhQjxLTDY6OSg1KyIrFgYEPzFJd3ygSEFUHQwTTkA9VTo6cVNWTCk2QzE6mJmsVVRyFQECLh8nXj5Af15RRik+hlsvpJSTYGWHHQ8WSDI9TSwuZEI5fkZRbkQzsYllYWB5IA8VNS9DZD1FZztEWDRAPSkzeFRFKRwmFwICLiQzb0VPTzA5JyEzOS9AHRIgGQkP',
  },
  {
    name: 'skill_icon_Vitality',
    rgb: 'JCcXPF8pS4k+N1ImOl0tSoQ6QXU+JiocPV0pT4w3KUYpQHc+PXFBJkEpT4k0Pl8rQHIyQU8phCYmSVc3RlE3gyUlQlAqQ389Q5FAZjIn7zQjpSQkpiUk7zQkZjMoQ5JASJZEWkwz1y0g5UQk5UQk1y0gWUgvSJZEOVw4Q5BMbDol4zUj4zUibT4pPns5NlAtNk4oUIc0MWQ6fDcpfDkrM2k+UIY0NEciJCAPJCghQXM8LlArLlAqQnc/JSoiJyoZ',
  },
  {
    name: 'skill_icon_WaterPool',
    rgb: 'GggLGgoUGgAAGgkkGwsmFgABGA4nGwcFGgcMGRlVGTmCFFCfEUqVKHK1HTlwFQAAGR1PFUe2FGvRJpflR5vpR5XdccXtKjdZFUe1E0GmFV7AIFqjOYvFSZ7jMHTOKXnPFyBhFkmzG3HCEzdyF0l3HZ7vD0mvEnPfFxU+HVGcRKDqEz2XFnXPFUSvFGbXF0mYGhUsFS9lHTtwKk+AFilkFzCLF0GhGSJLGgcJGQ0bGh41L2axGgMSGhElGgodGRUu',
  },
  {
    name: 'skill_icon_WaterSlide',
    rgb: 'GwYFGBEfDVGJH4e7IiguFwoVHTpQGhMcFAEKJlR/PsryC1yJBzV6F6biGTZTFAgUFQwfHTpMJXqPFQAAIx0tNldhVavgChpIJWWMVZauEwUJP0hLS1RTHCk6LZ/LFUlzGCg4Lq/YPVddK6LFKYCNHj9WAyZhFic9FA4mDUNtEFCPDjpsElajOn2HEEFrEQwqFhEgFyxXDCppDCZiECRZDDJyFS4+FiRHGwUEFihKGAwWFhAiFg4bFhMoGQoYGBUn',
  },
  {
    name: 'skill_icon_Water_Spirits',
    rgb: 'FhhHNnSqHw0oFwgeGhU1FVOvFkGVM6b1GhdLHR9AJmORHB09GhRGF0+4FzZfLTtaGgwYE27QMZHMHR0/Ewo0EWHEHaL0FjR+Fz6TFkWXGBYuEh0+U2qJPMr7Cqj9GkeNFz+eGh5HGBQzD1GVXNr/h+79U7v7EBs3GSaBFhZVJSM4x///2P7/ovT/L09xFQAAGhQ1GBM3ISdDlp+1rsHgSFRtDAAHHz6IGEqNGwYSFVGkChpWCwATCgQjRY3HNaDx',
  },
  {
    name: 'skill_icon_Waterball',
    rgb: 'GgcJGggLGgcIExYwFg8dFw0ZGgcKGwYFGgcJGwUDGgcHExEmEBY4CiZgCiRZERYyGggLGQ8cDRxHBD6TBEuoAVjECDdyFwoWFQ4fAD2nAlXPBV3RCWnXBli4EhUpERo9CCxzNJnVKLX5HZf2DoD5E0mIBx1QGQsRClSibOb2Ps7pQL76BWHRChxJDhEkGgcJBy5nK7Dhe+L7AmjPAylzDxk3ERYyGgYHGwIEBzBsAECMEBY5GQkNGwUFGgcJGgcJ',
  },
  {
    name: 'skill_icon_WhirlingWinds',
    rgb: 'JRUgLiEqMjUbLB4gJRMYGgcLGggJGQYIMS0iW2JYS1BASkFNVFFTaWRnMiMoGAYHPDIwYmBhHw4eGgYLSkhGX2hDOjE8KBkeJBEZipCDRUozFgQOMCQuQztHSEFRGQoSJhEbaXBbW2Q8QzREWlNbhoGOZ15rZl9tRjpAU0VTTWEpXWhTgIF2lp6Hk42idW15IhATMiIoGAcFJCAZgHuNXVNbh4WZqqq9GAUHFAECGwcKJBUiFwUHenWDLiEnV1BZ',
  },
  {
    name: 'skill_icon_Windgale',
    rgb: 'MSMnNCEpMCIsOiw3Slg2LjAeST1QKxofa2Jyg4SHQDo6UUpYTUVKQ0RDZmxjXGRMMygagqZZVFVcIBEaHw0ULCIsaWxlaWZqR0A3bXBeHw4ZHAoMGgcJKh0ghoKQMSEpOCcxdmqCZGFtLiAnEAAIQEYsk7didWx7GxAEnKqgeWuGRz1GWlRfpaGugJRwhYGMUkxQf6RRw92s0NXkurrWu9yqXms3BwAAKBYeNy4ceps4XlxLQjg/Q2AhLScTGQYJ',
  },
  {
    name: 'skill_icon_Windslash',
    rgb: 'GQQEHw4TJRchFwMHHQ0PHAYNWE1VHg0QHQ8WIxEVJRgaMjAdJBgXODkln5uqYllkU0ZUYVVhOS87QDs6QD0yZXpF19fwbmRvo6Sge3p5QUkpXlZmNSs4kYug4OH3SkE7u9euyM7QWGc3dW91s7PC+fj/qMCaYXwy09Py6OT8pJ+0Y1pmj4iLYlllPDoyNzo2i5Z30evG7O3/wsDQbGRzjIqitr6uib9TIx8KcZ1MxtDb3N316u3/2vPJxv9vYXg1',
  },
  {
    name: 'skill_icon_Windslash_3',
    rgb: 'HAkMGAQGFQIGJBUcKx8nMiQrTUJLNiYqEQAAJRYXamNmUEVTNyk2OS0/Vk5eOS44KBgdn6yaqruqZl1zbnRmZGZMW1heVEtbzsfg4fLkwda9i4ymYWllbG9mYVxlVkpVvtbA097c4ens4+L8rqzJd26LRjxORjg9pbCr6uv3uNOxz+XH4O3gvc29wtXAbW5YOSs32djo4+nvztjX4+vpwNW9hoaNJBYZDgAATUNLxcXT4eD24+P4r6rESz5JFAUG',
  },
  {
    name: 'skill_icon_Windveil',
    rgb: 'Hw4TGAYJKxkfJRMXNSYtLR8oHQ4VIhEXIRUeRjpIl5qaV1JXRztCiouQU0xdHRAXJxwofHiKZGFdoaSzg4CRw8LSjIiWHA0QJBETdG57ioaRTUNQa2pvl5ybg3uJIQ8SV0xTZFhimJucXVdaUEdHwMbMnJipcGZuOS43XVNddnB0eXeHbGV1a2Rma2Jsdm15HQ0SKBwrW15UamdpWVJaRk1BSz5JT0RNGwgLJhojIRIbUUVNRTc9JxkkKhwkIBAW',
  },
  {
    name: 'skill_iconnew_Fireball',
    rgb: 'GwcJGwYIFQYGLAcJOwYMPAQOFAAIUh4TGQcJJwgKTgMQPAAJQgMPjQkepUgbr0EcFAUINgAMdQwUVR0JyE0U/4om7WMmOAgMXzIAnoERy70//7km/8gL7pkofwQdUQEOuY4t//+3//ua+/xE/+EqhUgMVAAROwYLw6dj+/319/vL/+9WznUbPAYIQwMLIQYIb08l///y///o/u5/cxMnNgALGAgIGwcKFwQElXZKxKlib1QlFgYJGggJGgcJGgcJ',
  },
  {
    name: 'skill_iconnew_LightingStrike',
    rgb: 'GgcJGgcJGggKGwgKFwQEHi4ubpe3IxZEGgcJGggKHAgIHQUFETVFVJ6XQkebGhA2GggKGgYKEgYRFCdHHRw3QWl/JD6TEAQiFwUFKhwQjrCyaXuTVlyEY5ayiK2xLxUQHQoQEBNcLV+phKm2inqUSklMMSg4HwsLDwAEDRObAABYL1JMzf//Wo2hGBYjGQMDeZSUX3FuXaPKmN3tL09VFAACEgAAGAUH8f//1P3/////r8Lmr6CfYVNVUURGKRcZ',
  },
];

function normalizedSkillName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Build priority learned from recorded runs and the operator's preferred strategy. */
export function tollanSkillPriority(name: string): number {
  const skill = normalizedSkillName(name);

  if (
    skill.includes('collector') ||
    skill.includes('collectionrange') ||
    skill.includes('pickuprange') ||
    skill.includes('magnet')
  ) {
    return 2_000;
  }
  if (skill.includes('rejuvenation')) return 1_200;
  if (skill.includes('fireball')) return 1_080;
  if (skill.includes('inferno')) return 1_065;
  if (skill.includes('firestorm')) return 1_050;
  if (skill.includes('firebreath')) return 1_035;
  if (skill.includes('firetrail')) return 1_020;
  if (
    skill.includes('fireheart') ||
    skill.includes('eyesoffire') ||
    skill.includes('charred') ||
    skill.includes('windgalefire')
  ) {
    return 1_000;
  }

  if (skill.includes('waterspirit')) return 960;
  if (skill.includes('waterball')) return 920;
  if (skill.includes('lifesteal')) return 880;
  if (skill.includes('vitality') || skill.includes('ironveins')) return 850;

  if (skill.includes('light')) return 720;
  if (skill.includes('arcane')) return 640;

  if (
    skill.includes('waterslide') ||
    skill.includes('waterpool') ||
    skill.includes('waterworld') ||
    skill.includes('icebreath') ||
    skill.includes('waterheart')
  ) {
    return 300;
  }

  if (skill.includes('brutality') || skill.includes('transcendance')) return 590;
  if (skill.includes('scholar') || skill.includes('ranger')) return 550;
  if (skill.includes('traveler') || skill.includes('wanderer')) return 530;
  return 500;
}
